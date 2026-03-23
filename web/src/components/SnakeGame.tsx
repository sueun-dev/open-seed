import React, { useEffect, useRef, useState, useCallback } from "react";

const COLS = 20;
const ROWS = 20;
const CELL = 24;
const INITIAL_SPEED = 150;
const MIN_SPEED = 60;

type Pos = { x: number; y: number };
type Dir = "UP" | "DOWN" | "LEFT" | "RIGHT";

const opposite: Record<Dir, Dir> = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

function randPos(exclude: Pos[]): Pos {
  let pos: Pos;
  do {
    pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (exclude.some((p) => p.x === pos.x && p.y === pos.y));
  return pos;
}

function move(head: Pos, dir: Dir): Pos {
  switch (dir) {
    case "UP": return { x: head.x, y: head.y - 1 };
    case "DOWN": return { x: head.x, y: head.y + 1 };
    case "LEFT": return { x: head.x - 1, y: head.y };
    case "RIGHT": return { x: head.x + 1, y: head.y };
  }
}

type GameState = "idle" | "running" | "paused" | "over";

export default function SnakeGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    snake: [{ x: 10, y: 10 }] as Pos[],
    dir: "RIGHT" as Dir,
    nextDir: "RIGHT" as Dir,
    food: { x: 15, y: 10 } as Pos,
    score: 0,
    status: "idle" as GameState,
    speed: INITIAL_SPEED,
  });
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [display, setDisplay] = useState({ score: 0, status: "idle" as GameState });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const s = stateRef.current;

    // Background
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);

    // Grid
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL, 0);
      ctx.lineTo(x * CELL, ROWS * CELL);
      ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL);
      ctx.lineTo(COLS * CELL, y * CELL);
      ctx.stroke();
    }

    // Food — glowing red dot
    const fx = s.food.x * CELL + CELL / 2;
    const fy = s.food.y * CELL + CELL / 2;
    const grd = ctx.createRadialGradient(fx, fy, 2, fx, fy, CELL / 2 - 2);
    grd.addColorStop(0, "#ff6b6b");
    grd.addColorStop(1, "#c0392b");
    ctx.beginPath();
    ctx.arc(fx, fy, CELL / 2 - 3, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Snake
    s.snake.forEach((seg, i) => {
      const ratio = 1 - i / s.snake.length;
      const g = Math.floor(180 * ratio + 80);
      ctx.fillStyle = i === 0 ? "#4ade80" : `rgb(0, ${g}, 60)`;
      const pad = i === 0 ? 1 : 2;
      ctx.beginPath();
      ctx.roundRect(
        seg.x * CELL + pad,
        seg.y * CELL + pad,
        CELL - pad * 2,
        CELL - pad * 2,
        i === 0 ? 6 : 4
      );
      ctx.fill();
    });

    // Eyes on head
    if (s.snake.length > 0) {
      const head = s.snake[0];
      ctx.fillStyle = "#000";
      const eyeOffsets: Record<Dir, [number, number, number, number]> = {
        RIGHT: [CELL * 0.65, CELL * 0.3, CELL * 0.65, CELL * 0.7],
        LEFT: [CELL * 0.35, CELL * 0.3, CELL * 0.35, CELL * 0.7],
        UP: [CELL * 0.3, CELL * 0.35, CELL * 0.7, CELL * 0.35],
        DOWN: [CELL * 0.3, CELL * 0.65, CELL * 0.7, CELL * 0.65],
      };
      const [e1x, e1y, e2x, e2y] = eyeOffsets[s.dir];
      ctx.beginPath();
      ctx.arc(head.x * CELL + e1x, head.y * CELL + e1y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(head.x * CELL + e2x, head.y * CELL + e2y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  const tick = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== "running") return;

    s.dir = s.nextDir;
    const newHead = move(s.snake[0], s.dir);

    // Wall collision
    if (newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS) {
      s.status = "over";
      setDisplay({ score: s.score, status: "over" });
      draw();
      return;
    }

    // Self collision
    if (s.snake.slice(1).some((p) => p.x === newHead.x && p.y === newHead.y)) {
      s.status = "over";
      setDisplay({ score: s.score, status: "over" });
      draw();
      return;
    }

    const ate = newHead.x === s.food.x && newHead.y === s.food.y;
    s.snake = [newHead, ...s.snake];
    if (ate) {
      s.score++;
      s.food = randPos(s.snake);
      s.speed = Math.max(MIN_SPEED, INITIAL_SPEED - s.score * 4);
      setDisplay({ score: s.score, status: "running" });
    } else {
      s.snake.pop();
    }

    draw();
    loopRef.current = setTimeout(tick, s.speed);
  }, [draw]);

  const startGame = useCallback(() => {
    if (loopRef.current) clearTimeout(loopRef.current);
    const initSnake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    stateRef.current = {
      snake: initSnake,
      dir: "RIGHT",
      nextDir: "RIGHT",
      food: randPos(initSnake),
      score: 0,
      status: "running",
      speed: INITIAL_SPEED,
    };
    setDisplay({ score: 0, status: "running" });
    draw();
    loopRef.current = setTimeout(tick, INITIAL_SPEED);
  }, [draw, tick]);

  const togglePause = useCallback(() => {
    const s = stateRef.current;
    if (s.status === "running") {
      s.status = "paused";
      if (loopRef.current) clearTimeout(loopRef.current);
      setDisplay((d) => ({ ...d, status: "paused" }));
    } else if (s.status === "paused") {
      s.status = "running";
      setDisplay((d) => ({ ...d, status: "running" }));
      loopRef.current = setTimeout(tick, s.speed);
    }
  }, [tick]);

  useEffect(() => {
    draw();
    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      const map: Record<string, Dir> = {
        ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
        w: "UP", s: "DOWN", a: "LEFT", d: "RIGHT",
      };
      if (e.key === " ") {
        e.preventDefault();
        if (s.status === "idle" || s.status === "over") startGame();
        else togglePause();
        return;
      }
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      if (s.status === "idle" || s.status === "over") {
        startGame();
        return;
      }
      if (dir !== opposite[s.dir]) s.nextDir = dir;
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (loopRef.current) clearTimeout(loopRef.current);
    };
  }, [draw, startGame, togglePause]);

  const statusMsg =
    display.status === "idle" ? "Press SPACE or any arrow key to start" :
    display.status === "paused" ? "PAUSED — press SPACE to resume" :
    display.status === "over" ? "GAME OVER — press SPACE to restart" :
    null;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", width: COLS * CELL, alignItems: "center" }}>
        <span style={{ color: "#666", fontSize: 13 }}>WASD or Arrow Keys &nbsp;|&nbsp; SPACE to pause</span>
        <span style={{ color: "#4ade80", fontWeight: 700, fontSize: 18 }}>
          Score: {display.score}
        </span>
      </div>

      <div style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          width={COLS * CELL}
          height={ROWS * CELL}
          style={{ display: "block", border: "1px solid #222", borderRadius: 8, cursor: "pointer" }}
          onClick={() => {
            if (display.status === "idle" || display.status === "over") startGame();
            else togglePause();
          }}
        />
        {statusMsg && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", borderRadius: 8,
            background: "rgba(0,0,0,0.75)",
          }}>
            {display.status === "over" && (
              <div style={{ color: "#ff6b6b", fontSize: 36, fontWeight: 900, marginBottom: 8 }}>
                GAME OVER
              </div>
            )}
            {display.status === "over" && (
              <div style={{ color: "#fff", fontSize: 20, marginBottom: 16 }}>
                Score: {display.score}
              </div>
            )}
            <div style={{ color: "#aaa", fontSize: 14 }}>{statusMsg}</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={startGame}
          style={{
            padding: "8px 20px", borderRadius: 6, border: "1px solid #333",
            background: "#111", color: "#4ade80", fontWeight: 700, cursor: "pointer", fontSize: 13,
          }}
        >
          New Game
        </button>
        {(display.status === "running" || display.status === "paused") && (
          <button
            onClick={togglePause}
            style={{
              padding: "8px 20px", borderRadius: 6, border: "1px solid #333",
              background: "#111", color: "#eee", fontWeight: 700, cursor: "pointer", fontSize: 13,
            }}
          >
            {display.status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
      </div>
    </div>
  );
}
