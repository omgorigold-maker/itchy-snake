(() => {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const stageWrap = document.getElementById('stageWrap');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayDesc = document.getElementById('overlayDesc');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const soundBtn = document.getElementById('soundBtn');
  const scoreVal = document.getElementById('scoreVal');
  const bestVal = document.getElementById('bestVal');
  const itchStatus = document.getElementById('itchStatus');
  const itchFill = document.getElementById('itchFill');

  const GRID = 14;
  const CELL = canvas.width / GRID;
  const SCRATCH_INTERVAL_MS = 4000;
  const SCRATCH_DURATION_MS = 1350;
  const BASE_STEP_MS = 210;
  const MIN_STEP_MS = 70;

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  const OPPOSITE = {
    up: 'down',
    down: 'up',
    left: 'right',
    right: 'left',
  };

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let snake = [];
  let dir = 'right';
  let inputQueue = [];
  let food = { x: 14, y: 10 };
  let score = 0;
  let bestScore = Number(localStorage.getItem('itchySnakeBest') || 0);
  let soundEnabled = true;

  // Game states: 'idle' | 'playing' | 'paused' | 'gameover'
  let gameState = 'idle';
  let isOffscreen = false;

  // Timing
  let lastFrameTime = 0;
  let moveAccumulator = 0;
  let itchTimer = 0;
  let isScratching = false;
  let scratchElapsed = 0;
  let scratchSoundTick = 0;
  let rafId = null;

  // Floating particles
  let particles = [];

  // Web Audio setup (lazy-initialized on user gesture)
  let audioCtx = null;

  function ensureAudio() {
    if (!soundEnabled) return null;
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTone(freq, duration, type = 'sine', gainVal = 0.08, slideTo = null) {
    const ctxAudio = ensureAudio();
    if (!ctxAudio) return;
    const now = ctxAudio.currentTime;
    const osc = ctxAudio.createOscillator();
    const gain = ctxAudio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) {
      osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    }
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctxAudio.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  function playScritch() {
    const ctxAudio = ensureAudio();
    if (!ctxAudio) return;
    const now = ctxAudio.currentTime;
    const bufferSize = Math.floor(ctxAudio.sampleRate * 0.055);
    const buffer = ctxAudio.createBuffer(1, bufferSize, ctxAudio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = ctxAudio.createBufferSource();
    noise.buffer = buffer;

    const filter = ctxAudio.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600 + Math.random() * 600, now);
    filter.Q.setValueAtTime(2.5, now);

    const gain = ctxAudio.createGain();
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctxAudio.destination);
    noise.start(now);
  }

  function stepIntervalMs() {
    return Math.max(MIN_STEP_MS, BASE_STEP_MS - score * 2.3);
  }

  function resetGame() {
    const midY = Math.floor(GRID / 2);
    const headX = Math.floor(GRID / 2) - 1;
    snake = [
      { x: headX, y: midY },
      { x: headX - 1, y: midY },
      { x: headX - 2, y: midY },
      { x: headX - 3, y: midY },
    ];
    dir = 'right';
    inputQueue = [];
    score = 0;
    moveAccumulator = 0;
    itchTimer = 0;
    isScratching = false;
    scratchElapsed = 0;
    scratchSoundTick = 0;
    particles = [];
    spawnFood();
    updateHud();
  }

  function spawnFood() {
    const occupied = new Set(snake.map((s) => `${s.x},${s.y}`));
    const avoidWalls = score < 4;
    const open = [];
    const fallback = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (occupied.has(`${x},${y}`)) continue;
        const isOuter = x === 0 || x === GRID - 1 || y === 0 || y === GRID - 1;
        if (!avoidWalls || !isOuter) {
          open.push({ x, y });
        } else {
          fallback.push({ x, y });
        }
      }
    }
    const pool = open.length > 0 ? open : fallback;
    if (pool.length === 0) return;
    food = pool[Math.floor(Math.random() * pool.length)];
  }

  function spawnTextParticle(x, y, text, color = '#fbbf24') {
    particles.push({
      x,
      y,
      vy: -0.025,
      text,
      color,
      life: 1,
    });
  }

  function updateHud() {
    scoreVal.textContent = String(score);
    bestVal.textContent = String(bestScore);

    if (isScratching) {
      itchStatus.textContent = 'SCRATCHING!';
      itchStatus.classList.add('is-scratching');
      itchFill.style.width = '100%';
    } else {
      const remaining = Math.max(0, (SCRATCH_INTERVAL_MS - itchTimer) / 1000);
      itchStatus.textContent = `${remaining.toFixed(1)}s`;
      itchStatus.classList.remove('is-scratching');
      const pct = Math.min(100, (itchTimer / SCRATCH_INTERVAL_MS) * 100);
      itchFill.style.width = `${pct.toFixed(1)}%`;
    }
  }

  function showOverlay(title, desc, btnLabel) {
    overlayTitle.textContent = title;
    overlayDesc.innerHTML = desc;
    startBtn.textContent = btnLabel;
    overlay.classList.remove('is-hidden');
  }

  function hideOverlay() {
    overlay.classList.add('is-hidden');
  }

  function startGame() {
    ensureAudio();
    resetGame();
    gameState = 'playing';
    pauseBtn.textContent = 'Pause';
    hideOverlay();
    startLoop();
  }

  function togglePause() {
    if (gameState === 'playing') {
      gameState = 'paused';
      pauseBtn.textContent = 'Resume';
      showOverlay('Paused', "It's okay, you can scratch your balls too.", 'Resume');
    } else if (gameState === 'paused') {
      gameState = 'playing';
      pauseBtn.textContent = 'Pause';
      hideOverlay();
      lastFrameTime = performance.now();
      startLoop();
    }
  }

  function triggerGameOver() {
    gameState = 'gameover';
    playTone(220, 0.28, 'sawtooth', 0.08, 75);
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem('itchySnakeBest', String(bestScore));
    }
    updateHud();
    showOverlay(
      'Bonk! Game Over',
      `Final score: <strong>${score}</strong>. Ready for another round?`,
      'Play Again'
    );
  }

  function queueDirection(nextDir) {
    if (gameState !== 'playing') return;
    const lastPlanned = inputQueue.length > 0 ? inputQueue[inputQueue.length - 1] : dir;
    if (nextDir === lastPlanned || OPPOSITE[nextDir] === lastPlanned) return;
    if (inputQueue.length < 2) {
      inputQueue.push(nextDir);
    }
  }

  function startScratchBreak() {
    isScratching = true;
    scratchElapsed = 0;
    scratchSoundTick = 0;
    const anchor = getScratchAnchor();
    spawnTextParticle(anchor.x, anchor.y - 16, '*scritch scritch*', '#fbbf24');
    playScritch();
  }

  function finishScratchBreak() {
    isScratching = false;
    itchTimer = 0;
    const head = snake[0];
    spawnTextParticle(
      (head.x + 0.5) * CELL,
      head.y * CELL - 8,
      'ahh~',
      '#4ade80'
    );
    playTone(520, 0.12, 'triangle', 0.06, 720);
  }

  function stepSnake() {
    if (inputQueue.length > 0) {
      dir = inputQueue.shift();
    }

    const vec = DIRS[dir];
    const next = {
      x: snake[0].x + vec.x,
      y: snake[0].y + vec.y,
    };

    // Wall collision
    if (next.x < 0 || next.x >= GRID || next.y < 0 || next.y >= GRID) {
      triggerGameOver();
      return;
    }

    const eating = next.x === food.x && next.y === food.y;
    const bodyToCheck = eating ? snake : snake.slice(0, -1);

    if (bodyToCheck.some((seg) => seg.x === next.x && seg.y === next.y)) {
      triggerGameOver();
      return;
    }

    snake.unshift(next);
    if (eating) {
      score += 1;
      if (score > bestScore) {
        bestScore = score;
        localStorage.setItem('itchySnakeBest', String(bestScore));
      }
      playTone(440, 0.1, 'sine', 0.08, 680);
      spawnTextParticle((next.x + 0.5) * CELL, next.y * CELL, '+1', '#4ade80');
      spawnFood();
    } else {
      snake.pop();
    }
  }

  function getScratchAnchor() {
    // Lower-body / near-tail segment
    const idx = Math.max(1, snake.length - 2);
    const seg = snake[idx] || snake[0];
    return {
      x: (seg.x + 0.5) * CELL,
      y: (seg.y + 0.5) * CELL,
    };
  }

  function update(dt) {
    if (gameState !== 'playing') return;

    // Update floating particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.y += p.vy * dt;
      p.life -= dt / 900;
      if (p.life <= 0) particles.splice(i, 1);
    }

    if (isScratching) {
      scratchElapsed += dt;
      scratchSoundTick += dt;
      if (scratchSoundTick >= 220) {
        scratchSoundTick = 0;
        playScritch();
      }
      if (scratchElapsed >= SCRATCH_DURATION_MS) {
        finishScratchBreak();
      }
      updateHud();
      return;
    }

    itchTimer += dt;
    if (itchTimer >= SCRATCH_INTERVAL_MS) {
      startScratchBreak();
      updateHud();
      return;
    }

    moveAccumulator += dt;
    const stepMs = stepIntervalMs();
    while (moveAccumulator >= stepMs) {
      moveAccumulator -= stepMs;
      stepSnake();
      if (gameState !== 'playing') break;
    }

    updateHud();
  }

  function drawGrid() {
    ctx.fillStyle = '#0d1319';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < GRID; i++) {
      const pos = i * CELL;
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, canvas.height);
      ctx.moveTo(0, pos);
      ctx.lineTo(canvas.width, pos);
    }
    ctx.stroke();
  }

  function drawFood(now) {
    const cx = (food.x + 0.5) * CELL;
    const cy = (food.y + 0.5) * CELL;
    const pulse = reducedMotionQuery.matches ? 1 : 1 + Math.sin(now * 0.006) * 0.08;
    const r = CELL * 0.38 * pulse;

    // Soft glow
    ctx.save();
    ctx.fillStyle = 'rgba(248, 113, 113, 0.22)';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.45, 0, Math.PI * 2);
    ctx.fill();

    // Apple body
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(cx, cy + 1, r, 0, Math.PI * 2);
    ctx.fill();

    // Highlight
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.3, cy - r * 0.25, r * 0.25, 0, Math.PI * 2);
    ctx.fill();

    // Leaf
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.25, cy - r * 0.95, r * 0.42, r * 0.22, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSnake(now) {
    const wobbleAmp = isScratching && !reducedMotionQuery.matches ? 2.2 : 0;

    // Draw segments tail-to-head
    for (let i = snake.length - 1; i >= 0; i--) {
      const seg = snake[i];
      const isHead = i === 0;
      const ratio = i / Math.max(1, snake.length - 1);
      const radius = isHead ? CELL * 0.45 : CELL * (0.42 - ratio * 0.12);

      const jitterX = wobbleAmp ? Math.sin(now * 0.04 + i) * wobbleAmp : 0;
      const jitterY = wobbleAmp ? Math.cos(now * 0.045 + i) * wobbleAmp : 0;

      const cx = (seg.x + 0.5) * CELL + jitterX;
      const cy = (seg.y + 0.5) * CELL + jitterY;

      ctx.fillStyle = isHead ? '#4ade80' : i % 2 === 0 ? '#22c55e' : '#16a34a';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      if (isHead) {
        drawHeadDetails(cx, cy, radius, now);
      }
    }

    if (isScratching) {
      drawScratchAnimation(now);
    }
  }

  function drawHeadDetails(cx, cy, r, now) {
    const v = DIRS[dir];
    const perp = { x: -v.y, y: v.x };
    const eyeForward = r * 0.28;
    const eyeSpread = r * 0.42;

    const e1x = cx + v.x * eyeForward + perp.x * eyeSpread;
    const e1y = cy + v.y * eyeForward + perp.y * eyeSpread;
    const e2x = cx + v.x * eyeForward - perp.x * eyeSpread;
    const e2y = cy + v.y * eyeForward - perp.y * eyeSpread;

    if (isScratching) {
      // Happy relieved closed eyes (^ ^) + blush
      ctx.strokeStyle = '#072210';
      ctx.lineWidth = Math.max(2, r * 0.16);
      ctx.lineCap = 'round';
      for (const [ex, ey] of [
        [e1x, e1y],
        [e2x, e2y],
      ]) {
        ctx.beginPath();
        ctx.arc(ex, ey + r * 0.12, r * 0.25, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }

      // Rosy blush cheeks
      ctx.fillStyle = 'rgba(248, 113, 113, 0.55)';
      ctx.beginPath();
      ctx.arc(cx + perp.x * (r * 0.65), cy + perp.y * (r * 0.65), r * 0.24, 0, Math.PI * 2);
      ctx.arc(cx - perp.x * (r * 0.65), cy - perp.y * (r * 0.65), r * 0.24, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Determined eyes
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(e1x, e1y, r * 0.27, 0, Math.PI * 2);
      ctx.arc(e2x, e2y, r * 0.27, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#09130c';
      ctx.beginPath();
      ctx.arc(e1x + v.x * (r * 0.09), e1y + v.y * (r * 0.09), r * 0.14, 0, Math.PI * 2);
      ctx.arc(e2x + v.x * (r * 0.09), e2y + v.y * (r * 0.09), r * 0.14, 0, Math.PI * 2);
      ctx.fill();

      // Occasional flicking tongue
      if (Math.sin(now * 0.008) > 0.45) {
        const tx = cx + v.x * (r + r * 0.48);
        const ty = cy + v.y * (r + r * 0.48);
        ctx.strokeStyle = '#fb7185';
        ctx.lineWidth = Math.max(2, r * 0.15);
        ctx.beginPath();
        ctx.moveTo(cx + v.x * r * 0.85, cy + v.y * r * 0.85);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx + v.x * (r * 0.24) + perp.x * (r * 0.24), ty + v.y * (r * 0.24) + perp.y * (r * 0.24));
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx + v.x * (r * 0.24) - perp.x * (r * 0.24), ty + v.y * (r * 0.24) - perp.y * (r * 0.24));
        ctx.stroke();
      }
    }
  }

  function drawScratchAnimation(now) {
    const anchor = getScratchAnchor();
    const s = CELL / 28;
    const t = now * 0.028;
    const bounce = reducedMotionQuery.matches ? 0 : Math.sin(t * 1.5) * 1.8 * s;

    ctx.save();
    // Goofy cartoon spheres tucked under the lower body
    const bx = anchor.x;
    const by = anchor.y + 9 * s + bounce * 0.4;

    ctx.fillStyle = '#86efac';
    ctx.strokeStyle = '#14532d';
    ctx.lineWidth = 1.6 * s;
    for (const offset of [-5.5 * s, 5.5 * s]) {
      ctx.beginPath();
      ctx.arc(bx + offset, by, 5.2 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Little cartoon scratching hand/claw moving back and forth
    const scratchX = bx + (reducedMotionQuery.matches ? 2 * s : Math.sin(t * 2.2) * 7 * s);
    const scratchY = by + (reducedMotionQuery.matches ? 0 : Math.cos(t * 2.2) * 2.5 * s);

    // Little 3-fingered cartoon hand
    ctx.fillStyle = '#4ade80';
    ctx.strokeStyle = '#09130c';
    ctx.lineWidth = 1.4 * s;
    ctx.beginPath();
    ctx.arc(scratchX, scratchY, 4.2 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Action scratch lines
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.8 * s;
    for (let i = -1; i <= 1; i++) {
      const lx = scratchX + (8 + i * 3) * s;
      const ly = scratchY + (-5 + Math.abs(i) * 2) * s;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + 4 * s, ly - 4 * s);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();
  }

  function render(now) {
    drawGrid();
    drawFood(now);
    drawSnake(now);
    drawParticles();
  }

  function loop(now) {
    if (isOffscreen || gameState === 'paused') {
      rafId = null;
      return;
    }

    if (!lastFrameTime) lastFrameTime = now;
    const dt = Math.min(100, now - lastFrameTime);
    lastFrameTime = now;

    update(dt);
    render(now);

    if (gameState === 'playing') {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
    }
  }

  function startLoop() {
    if (rafId !== null || isOffscreen) return;
    lastFrameTime = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // Keyboard controls
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const map = {
      arrowup: 'up',
      w: 'up',
      arrowdown: 'down',
      s: 'down',
      arrowleft: 'left',
      a: 'left',
      arrowright: 'right',
      d: 'right',
    };

    if (map[key]) {
      e.preventDefault();
      if (gameState === 'idle') startGame();
      queueDirection(map[key]);
    } else if (key === ' ' || key === 'p') {
      if (gameState === 'playing' || gameState === 'paused') {
        e.preventDefault();
        togglePause();
      }
    } else if (key === 'r') {
      startGame();
    }
  });

  // Touch swipe controls + hold-to-pause on stage
  let touchStart = null;
  let holdPauseTimer = null;
  let isHoldPaused = false;
  const HOLD_PAUSE_MS = 220;

  function clearHoldPauseTimer() {
    if (holdPauseTimer !== null) {
      clearTimeout(holdPauseTimer);
      holdPauseTimer = null;
    }
  }

  stageWrap.addEventListener(
    'touchstart',
    (e) => {
      if (e.target.closest('button')) return;
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };

      if (gameState === 'playing') {
        clearHoldPauseTimer();
        holdPauseTimer = setTimeout(() => {
          holdPauseTimer = null;
          if (gameState === 'playing') {
            isHoldPaused = true;
            togglePause();
          }
        }, HOLD_PAUSE_MS);
      }
    },
    { passive: true }
  );

  canvas.addEventListener(
    'touchmove',
    (e) => {
      if (!touchStart) return;
      const t = e.touches[0];
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      if (Math.abs(dx) > 14 || Math.abs(dy) > 14) {
        clearHoldPauseTimer();
      }
      if (Math.abs(dx) < 22 && Math.abs(dy) < 22) return;
      if (isHoldPaused || gameState !== 'playing') return;
      if (Math.abs(dx) > Math.abs(dy)) {
        queueDirection(dx > 0 ? 'right' : 'left');
      } else {
        queueDirection(dy > 0 ? 'down' : 'up');
      }
      touchStart = { x: t.clientX, y: t.clientY };
    },
    { passive: true }
  );

  function releaseHoldPause() {
    clearHoldPauseTimer();
    touchStart = null;
    if (isHoldPaused) {
      isHoldPaused = false;
      if (gameState === 'paused') {
        togglePause();
      }
    }
  }

  window.addEventListener('touchend', releaseHoldPause, { passive: true });
  window.addEventListener('touchcancel', releaseHoldPause, { passive: true });

  // On-screen D-pad
  document.querySelectorAll('.dpad-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (gameState === 'idle') startGame();
      queueDirection(btn.dataset.dir);
    });
  });

  startBtn.addEventListener('click', () => {
    if (gameState === 'paused') {
      togglePause();
    } else {
      startGame();
    }
  });

  pauseBtn.addEventListener('click', () => {
    if (gameState === 'idle' || gameState === 'gameover') return;
    togglePause();
  });

  soundBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    soundBtn.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
  });

  // Pause rendering when stage is off-screen (contentvisibilityautostatechange + IntersectionObserver fallback)
  if ('contentVisibility' in document.documentElement.style) {
    stageWrap.addEventListener('contentvisibilityautostatechange', (e) => {
      isOffscreen = e.skipped;
      if (isOffscreen) {
        stopLoop();
      } else if (gameState === 'playing') {
        startLoop();
      }
    });
  } else if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          isOffscreen = !entry.isIntersecting;
          if (isOffscreen) stopLoop();
          else if (gameState === 'playing') startLoop();
        });
      },
      { rootMargin: '150px' }
    );
    observer.observe(stageWrap);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLoop();
    } else if (gameState === 'playing' && !isOffscreen) {
      startLoop();
    }
  });

  // Initial draw
  resetGame();
  render(performance.now());
})();
