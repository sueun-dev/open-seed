import { drawHud } from '../ui/hud.js';

type Vector = { x: number; y: number };

type Player = {
  x: number;
  y: number;
  size: number;
  speed: number;
};

type Hazard = {
  x: number;
  y: number;
  radius: number;
  velocity: Vector;
};

type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

const PLAYFIELD_WIDTH = 900;
const PLAYFIELD_HEIGHT = 600;
const BASE_SPAWN_RATE = 1.1;
const BASE_HAZARD_SPEED = 190;
const MAX_DIFFICULTY = 3.8;
const SAFE_RADIUS = 170;

export class GameLoop {
  private readonly context: CanvasRenderingContext2D;
  private readonly input: InputState;
  private animationFrameId = 0;
  private lastTimestamp = 0;
  private spawnAccumulator = 0;
  private elapsedTime = 0;
  private bestTime = 0;
  private player: Player;
  private hazards: Hazard[] = [];
  private isGameOver = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = this.canvas.getContext('2d');

    if (!context) {
      throw new Error('2D canvas context is required.');
    }

    this.context = context;
    this.canvas.width = PLAYFIELD_WIDTH;
    this.canvas.height = PLAYFIELD_HEIGHT;
    this.input = { up: false, down: false, left: false, right: false };
    this.player = this.createPlayer();
  }

  start(): void {
    this.stop();
    this.lastTimestamp = performance.now();
    this.animationFrameId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.animationFrameId !== 0) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  handleKeyChange(code: string, pressed: boolean): boolean {
    if (code === 'ArrowUp' || code === 'KeyW') {
      this.input.up = pressed;
      return true;
    }

    if (code === 'ArrowDown' || code === 'KeyS') {
      this.input.down = pressed;
      return true;
    }

    if (code === 'ArrowLeft' || code === 'KeyA') {
      this.input.left = pressed;
      return true;
    }

    if (code === 'ArrowRight' || code === 'KeyD') {
      this.input.right = pressed;
      return true;
    }

    if ((code === 'Enter' || code === 'Space') && pressed && this.isGameOver) {
      this.restart();
      return true;
    }

    return code === 'Enter' || code === 'Space';
  }

  resetInput(): void {
    this.input.up = false;
    this.input.down = false;
    this.input.left = false;
    this.input.right = false;
  }

  private readonly frame = (timestamp: number): void => {
    const rawDelta = (timestamp - this.lastTimestamp) / 1000;
    const deltaSeconds = Math.min(Math.max(rawDelta, 0), 0.033);
    this.lastTimestamp = timestamp;

    if (!this.isGameOver) {
      this.update(deltaSeconds);
    }

    this.render();
    this.animationFrameId = requestAnimationFrame(this.frame);
  };

  private update(deltaSeconds: number): void {
    this.elapsedTime += deltaSeconds;
    this.spawnAccumulator += deltaSeconds;

    const horizontal = Number(this.input.right) - Number(this.input.left);
    const vertical = Number(this.input.down) - Number(this.input.up);
    const magnitude = Math.hypot(horizontal, vertical) || 1;

    this.player.x += (horizontal / magnitude) * this.player.speed * deltaSeconds;
    this.player.y += (vertical / magnitude) * this.player.speed * deltaSeconds;
    this.player.x = clamp(this.player.x, 0, PLAYFIELD_WIDTH - this.player.size);
    this.player.y = clamp(this.player.y, 0, PLAYFIELD_HEIGHT - this.player.size);

    const difficulty = this.getDifficulty();
    const spawnInterval = BASE_SPAWN_RATE / difficulty;

    if (this.spawnAccumulator >= spawnInterval) {
      this.spawnAccumulator = 0;
      this.hazards.push(this.createHazard(difficulty));
    }

    for (const hazard of this.hazards) {
      hazard.x += hazard.velocity.x * deltaSeconds;
      hazard.y += hazard.velocity.y * deltaSeconds;
    }

    this.hazards = this.hazards.filter((hazard) => this.isHazardVisible(hazard));

    if (this.hazards.some((hazard) => this.isColliding(hazard))) {
      this.isGameOver = true;
      this.bestTime = Math.max(this.bestTime, this.elapsedTime);
      this.resetInput();
    }
  }

  private render(): void {
    this.context.clearRect(0, 0, PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT);

    this.context.fillStyle = '#09111f';
    this.context.fillRect(0, 0, PLAYFIELD_WIDTH, PLAYFIELD_HEIGHT);

    this.context.strokeStyle = '#1d2e52';
    this.context.lineWidth = 2;
    this.context.strokeRect(8, 8, PLAYFIELD_WIDTH - 16, PLAYFIELD_HEIGHT - 16);

    this.context.fillStyle = '#29d391';
    this.context.fillRect(this.player.x, this.player.y, this.player.size, this.player.size);

    this.context.fillStyle = '#ff6b6b';
    for (const hazard of this.hazards) {
      this.context.beginPath();
      this.context.arc(hazard.x, hazard.y, hazard.radius, 0, Math.PI * 2);
      this.context.fill();
    }

    drawHud(this.context, PLAYFIELD_WIDTH, {
      elapsedTime: this.elapsedTime,
      bestTime: this.bestTime,
      difficulty: this.getDifficulty(),
      isGameOver: this.isGameOver,
    });
  }

  private restart(): void {
    this.elapsedTime = 0;
    this.spawnAccumulator = 0;
    this.hazards = [];
    this.isGameOver = false;
    this.player = this.createPlayer();
    this.resetInput();
  }

  private createPlayer(): Player {
    return {
      x: PLAYFIELD_WIDTH / 2 - 14,
      y: PLAYFIELD_HEIGHT / 2 - 14,
      size: 28,
      speed: 280,
    };
  }

  private createHazard(difficulty: number): Hazard {
    const fromLeft = Math.random() < 0.5;
    const entryY = 40 + Math.random() * (PLAYFIELD_HEIGHT - 80);
    const x = fromLeft ? -24 : PLAYFIELD_WIDTH + 24;
    const targetX = this.player.x + this.player.size / 2;
    const targetY = this.player.y + this.player.size / 2;
    const directionX = targetX - x;
    const directionY = targetY - entryY;
    const directionLength = Math.hypot(directionX, directionY) || 1;
    const speed = BASE_HAZARD_SPEED * difficulty;

    let spawnX = x;
    let spawnY = entryY;
    const distanceToPlayer = Math.hypot(targetX - spawnX, targetY - spawnY);

    if (distanceToPlayer < SAFE_RADIUS) {
      spawnY = targetY + (spawnY < targetY ? SAFE_RADIUS : -SAFE_RADIUS);
      spawnY = clamp(spawnY, 24, PLAYFIELD_HEIGHT - 24);
    }

    return {
      x: spawnX,
      y: spawnY,
      radius: 14,
      velocity: {
        x: (directionX / directionLength) * speed,
        y: (directionY / directionLength) * speed,
      },
    };
  }

  private isHazardVisible(hazard: Hazard): boolean {
    return (
      hazard.x + hazard.radius >= -60 &&
      hazard.x - hazard.radius <= PLAYFIELD_WIDTH + 60 &&
      hazard.y + hazard.radius >= -60 &&
      hazard.y - hazard.radius <= PLAYFIELD_HEIGHT + 60
    );
  }

  private isColliding(hazard: Hazard): boolean {
    const playerCenterX = this.player.x + this.player.size / 2;
    const playerCenterY = this.player.y + this.player.size / 2;
    const closestX = clamp(hazard.x, this.player.x, this.player.x + this.player.size);
    const closestY = clamp(hazard.y, this.player.y, this.player.y + this.player.size);
    const distanceX = hazard.x - closestX;
    const distanceY = hazard.y - closestY;

    return distanceX * distanceX + distanceY * distanceY <= hazard.radius * hazard.radius;
  }

  private getDifficulty(): number {
    return Math.min(1 + this.elapsedTime * 0.08, MAX_DIFFICULTY);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
