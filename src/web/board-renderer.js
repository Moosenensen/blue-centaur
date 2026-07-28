const BoardRenderer = (function () {
  let _potionImage = null;
  let _potionImageLoading = false;

  function loadPotionImage() {
    if (_potionImage || _potionImageLoading) return;
    _potionImageLoading = true;
    const img = new Image();
    img.onload = () => {
      _potionImage = img;
    };
    img.onerror = () => {
      _potionImageLoading = false;
    };
    img.src = "/invulnerability-potion.png";
  }

  if (typeof window !== "undefined") {
    loadPotionImage();
  }

  function hexToRgba(hex, alpha) {
    let color = hex;
    if (!color || typeof color !== "string") {
      return `rgba(136, 136, 136, ${alpha})`;
    }
    color = color.replace("#", "");
    if (color.length === 3) {
      color = color
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const r = parseInt(color.substring(0, 2), 16) || 136;
    const g = parseInt(color.substring(2, 4), 16) || 136;
    const b = parseInt(color.substring(4, 6), 16) || 136;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Given the previous turn's snakes and the current turn's snakes, return the
  // snakes that vanished (present last turn, gone this turn) along with their
  // LAST-KNOWN head position and body. We deliberately do NOT infer or advance
  // the death cell: the game server currently removes a snake from board.snakes
  // the moment it dies, so its true final resting place is not available here.
  // Reporting the last-known position is honest (that is genuinely where the
  // snake was); a real final-resting-place marker requires the server to keep
  // dead snakes in the state for one turn. `excludeIds` skips snakes whose
  // markers are drawn explicitly elsewhere (e.g. our own snake).
  function getDisappearedSnakes(prevSnakes, currentSnakes, excludeIds) {
    if (!prevSnakes || prevSnakes.length === 0) return [];
    const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
    const currentIds = new Set((currentSnakes || []).map((s) => s.id));
    const dead = [];
    prevSnakes.forEach((s) => {
      if (currentIds.has(s.id) || exclude.has(s.id)) return;
      const prevBody =
        s.body && s.body.length ? s.body : s.head ? [s.head] : [];
      if (!prevBody.length) return;
      dead.push({
        id: s.id,
        head: prevBody[0],
        body: prevBody.slice(),
        color: s.customizations?.color || s.color || "#888888",
        emoji: s.emoji || "\u{1F40D}",
      });
    });
    return dead;
  }

  // Move a board cell one step in a Battlesnake direction. Returns null for
  // missing inputs so callers can fall back gracefully. y grows upward in board
  // coordinates (the renderer flips it for canvas y).
  function applyDirection(cell, move) {
    if (!cell || !move) return null;
    switch (move) {
      case "up":
        return { x: cell.x, y: cell.y + 1 };
      case "down":
        return { x: cell.x, y: cell.y - 1 };
      case "left":
        return { x: cell.x - 1, y: cell.y };
      case "right":
        return { x: cell.x + 1, y: cell.y };
    }
    return null;
  }

  // Single source of truth for on-board click hit-testing. Maps a click event
  // to a board cell using the CSS-displayed size (`getBoundingClientRect`) for
  // BOTH the cell size and the click offset, so it stays correct when the canvas
  // is scaled by CSS (its internal pixel buffer can differ from its rendered
  // size). Returns the board cell `{x, y}` (origin bottom-left, matching the
  // renderer's coordinate system). Callers should range-check against the board.
  function getClickedCell(canvas, board, event) {
    if (!canvas || !board) return null;
    const rect = canvas.getBoundingClientRect();
    const cellSize = Math.min(rect.width / board.width, rect.height / board.height);
    if (!cellSize) return null;
    const x = Math.floor((event.clientX - rect.left) / cellSize);
    const y = board.height - 1 - Math.floor((event.clientY - rect.top) / cellSize);
    return { x, y };
  }

  // Find the first snake whose body occupies `cell`. An optional `filter(snake)`
  // predicate lets each surface keep its own clickability gating rule.
  function findSnakeAtCell(board, cell, filter) {
    if (!board || !cell) return null;
    for (const snake of board.snakes) {
      if (filter && !filter(snake)) continue;
      if (snake.body.some((seg) => seg.x === cell.x && seg.y === cell.y)) {
        return snake;
      }
    }
    return null;
  }

  // Find the id of the snake whose Voronoi territory owns `cell`, or null.
  function findTerritoryOwnerAtCell(territoryCells, cell) {
    if (!territoryCells || !cell) return null;
    for (const [sid, cells] of Object.entries(territoryCells)) {
      if (cells && cells.some((c) => c.x === cell.x && c.y === cell.y)) {
        return sid;
      }
    }
    return null;
  }

  // Draw a dead-head marker at a board cell. A solid marker (shadow=false) is a
  // filled disc in the snake's color with a white ✗; a shadow marker
  // (shadow=true) is a ghosted/translucent disc with a dashed outline and a
  // colored ✗, used for our snake's INTENDED (attempted) move when it differs
  // from where the server actually placed us.
  function drawDeathMarker(ctx, head, boardHeight, cellSize, color, shadow) {
    if (!head) return;
    const cx = head.x * cellSize + cellSize / 2;
    const cy = (boardHeight - 1 - head.y) * cellSize + cellSize / 2;
    const r = cellSize * 0.34;
    const markColor = color || "#888888";
    ctx.save();
    if (shadow) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = markColor;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.setLineDash([
        Math.max(2, cellSize * 0.1),
        Math.max(2, cellSize * 0.08),
      ]);
      ctx.lineWidth = Math.max(1.5, cellSize * 0.06);
      ctx.strokeStyle = markColor;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = markColor;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, cellSize * 0.07);
      ctx.strokeStyle = "#000000";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const d = r * 0.55;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
    ctx.strokeStyle = shadow ? markColor : "#ffffff";
    ctx.globalAlpha = shadow ? 0.85 : 1;
    ctx.beginPath();
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
    ctx.restore();
  }

  // Drawn at a snake's LAST-KNOWN head when we have no authoritative final
  // resting position from the server. A "?" inside a disc with arrows pointing
  // outward in all four directions: it could have ended up anywhere from here.
  function drawUnknownDeathMarker(ctx, head, boardHeight, cellSize, color) {
    if (!head) return;
    const cx = head.x * cellSize + cellSize / 2;
    const cy = (boardHeight - 1 - head.y) * cellSize + cellSize / 2;
    const r = cellSize * 0.34;
    const markColor = color || "#888888";
    ctx.save();
    // Disc background so the glyph reads on any board cell.
    ctx.fillStyle = markColor;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, cellSize * 0.07);
    ctx.strokeStyle = "#000000";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Four arrows pointing outward (up, down, left, right) from the disc edge.
    const arrowColor = "#000000";
    ctx.strokeStyle = arrowColor;
    ctx.fillStyle = arrowColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, cellSize * 0.06);
    const start = r * 1.02;
    const end = r * 1.5;
    const headLen = Math.max(2, cellSize * 0.11);
    const dirs = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];
    for (const dir of dirs) {
      const sx = cx + dir.x * start;
      const sy = cy + dir.y * start;
      const ex = cx + dir.x * end;
      const ey = cy + dir.y * end;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // Arrowhead: two short strokes angled back from the tip (perpendicular).
      const px = -dir.y;
      const py = dir.x;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(
        ex - dir.x * headLen + px * headLen * 0.6,
        ey - dir.y * headLen + py * headLen * 0.6,
      );
      ctx.moveTo(ex, ey);
      ctx.lineTo(
        ex - dir.x * headLen - px * headLen * 0.6,
        ey - dir.y * headLen - py * headLen * 0.6,
      );
      ctx.stroke();
    }

    // "?" glyph centered in the disc.
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${Math.max(8, Math.round(cellSize * 0.5))}px sans-serif`;
    ctx.fillText("?", cx, cy + cellSize * 0.02);
    ctx.restore();
  }

  function getMoveQuality(score, allScores) {
    if (score == null || allScores.length === 0) return "not-evaluated";
    const maxScore = Math.max(...allScores);
    const minScore = Math.min(...allScores);
    const range = maxScore - minScore;
    if (range === 0) return "neutral";
    const normalized = (score - minScore) / range;
    if (normalized >= 0.8) return "best";
    if (normalized >= 0.5) return "good";
    if (normalized >= 0.2) return "neutral";
    return "bad";
  }

  function getScoreColor(score, allScores) {
    if (score == null || allScores.length === 0)
      return "rgba(100, 100, 100, 0.3)";
    const maxScore = Math.max(...allScores);
    const minScore = Math.min(...allScores);
    const range = maxScore - minScore;
    if (range === 0 || allScores.length === 1) {
      const hue = score > 0 ? 90 : score < 0 ? 0 : 60;
      return `hsla(${hue}, 70%, 50%, 0.3)`;
    }
    const normalized = (score - minScore) / range;
    const hue = normalized * 120;
    return `hsla(${hue}, 70%, 50%, 0.3)`;
  }

  function hexToRgb(hex) {
    let color = hex || "#888888";
    color = color.replace("#", "");
    if (color.length === 3)
      color = color
        .split("")
        .map((c) => c + c)
        .join("");
    return {
      r: parseInt(color.substring(0, 2), 16) || 136,
      g: parseInt(color.substring(2, 4), 16) || 136,
      b: parseInt(color.substring(4, 6), 16) || 136,
    };
  }

  function renderTerritoryBoundaries(
    ctx,
    territoryCells,
    snakeColorMap,
    boardHeight,
    cellSize,
    selectedSnake,
    bodyOwnerMap,
  ) {
    const ownerMap = {};
    Object.entries(territoryCells).forEach(([sid, cells]) => {
      if (!cells || cells.length === 0) return;
      cells.forEach((cell) => {
        ownerMap[`${cell.x},${cell.y}`] = sid;
      });
    });

    function shouldDrawBoundary(sid, nx, ny) {
      const nk = `${nx},${ny}`;
      if (ownerMap[nk] === sid) return false;
      if (bodyOwnerMap && bodyOwnerMap[nk] === sid) return false;
      return true;
    }

    const glowDepth = Math.max(4, Math.floor(cellSize * 0.4));
    const lineWidth = Math.max(1.5, cellSize * 0.06);

    Object.entries(territoryCells).forEach(([sid, cells]) => {
      if (!cells || cells.length === 0) return;
      const snakeColor = snakeColorMap[sid] || "#888888";
      const rgb = hexToRgb(snakeColor);
      const glowAlpha = selectedSnake === sid ? 0.6 : 0.45;

      cells.forEach((cell) => {
        const px = cell.x * cellSize;
        const py = (boardHeight - 1 - cell.y) * cellSize;

        const edges = [
          { dx: 0, dy: 1, dir: "top" },
          { dx: 0, dy: -1, dir: "bottom" },
          { dx: -1, dy: 0, dir: "left" },
          { dx: 1, dy: 0, dir: "right" },
        ];

        edges.forEach(({ dx, dy, dir }) => {
          if (!shouldDrawBoundary(sid, cell.x + dx, cell.y + dy)) return;
          let grad;
          switch (dir) {
            case "top":
              grad = ctx.createLinearGradient(px, py, px, py + glowDepth);
              grad.addColorStop(
                0,
                `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${glowAlpha})`,
              );
              grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(px, py, cellSize, glowDepth);
              break;
            case "bottom":
              grad = ctx.createLinearGradient(
                px,
                py + cellSize,
                px,
                py + cellSize - glowDepth,
              );
              grad.addColorStop(
                0,
                `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${glowAlpha})`,
              );
              grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(px, py + cellSize - glowDepth, cellSize, glowDepth);
              break;
            case "left":
              grad = ctx.createLinearGradient(px, py, px + glowDepth, py);
              grad.addColorStop(
                0,
                `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${glowAlpha})`,
              );
              grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(px, py, glowDepth, cellSize);
              break;
            case "right":
              grad = ctx.createLinearGradient(
                px + cellSize,
                py,
                px + cellSize - glowDepth,
                py,
              );
              grad.addColorStop(
                0,
                `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${glowAlpha})`,
              );
              grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
              ctx.fillStyle = grad;
              ctx.fillRect(px + cellSize - glowDepth, py, glowDepth, cellSize);
              break;
          }
        });
      });
    });

    Object.entries(territoryCells).forEach(([sid, cells]) => {
      if (!cells || cells.length === 0) return;
      const snakeColor = snakeColorMap[sid] || "#888888";
      const alpha = selectedSnake === sid ? 1.0 : 0.85;
      ctx.strokeStyle = hexToRgba(snakeColor, alpha);
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "square";

      ctx.beginPath();
      cells.forEach((cell) => {
        const px = cell.x * cellSize;
        const py = (boardHeight - 1 - cell.y) * cellSize;

        if (shouldDrawBoundary(sid, cell.x, cell.y + 1)) {
          ctx.moveTo(px, py);
          ctx.lineTo(px + cellSize, py);
        }
        if (shouldDrawBoundary(sid, cell.x, cell.y - 1)) {
          ctx.moveTo(px, py + cellSize);
          ctx.lineTo(px + cellSize, py + cellSize);
        }
        if (shouldDrawBoundary(sid, cell.x - 1, cell.y)) {
          ctx.moveTo(px, py);
          ctx.lineTo(px, py + cellSize);
        }
        if (shouldDrawBoundary(sid, cell.x + 1, cell.y)) {
          ctx.moveTo(px + cellSize, py);
          ctx.lineTo(px + cellSize, py + cellSize);
        }
      });
      ctx.stroke();
      ctx.lineCap = "butt";
    });
  }

  function getSnakeGap(cellSize) {
    return Math.max(2, Math.floor(cellSize * 0.15));
  }

  function buildPathNeighbors(snake) {
    const pathNeighbors = {};
    for (let i = 0; i < snake.body.length; i++) {
      const key = `${snake.body[i].x},${snake.body[i].y}`;
      if (!pathNeighbors[key]) pathNeighbors[key] = new Set();
      if (i > 0) {
        pathNeighbors[key].add(`${snake.body[i - 1].x},${snake.body[i - 1].y}`);
      }
      if (i < snake.body.length - 1) {
        pathNeighbors[key].add(`${snake.body[i + 1].x},${snake.body[i + 1].y}`);
      }
    }
    return pathNeighbors;
  }

  function getCellConnections(segment, pathNeighbors) {
    const key = `${segment.x},${segment.y}`;
    const neighbors = pathNeighbors[key] || new Set();
    return {
      hasTop: neighbors.has(`${segment.x},${segment.y + 1}`),
      hasBottom: neighbors.has(`${segment.x},${segment.y - 1}`),
      hasLeft: neighbors.has(`${segment.x - 1},${segment.y}`),
      hasRight: neighbors.has(`${segment.x + 1},${segment.y}`),
    };
  }

  function renderSnakeUnified(ctx, snake, boardHeight, cellSize, options) {
    if (snake.body.length === 0) return;

    const snakeColor = snake.customizations?.color || snake.color || "#888888";
    const gap = getSnakeGap(cellSize);
    const pathNeighbors = buildPathNeighbors(snake);
    const selectionGlow = options?.selectionGlow || null;
    const isControlled = options?.isControlled || false;
    const invulnLevel = snake.invulnerabilityLevel || 0;
    // Ghost mode renders a dead snake using the exact same continuous body
    // shape as a live snake, but translucent and with a colored outline, so a
    // dead snake reads as the same creature, just faded out.
    const ghost = options?.ghost || false;

    const visited = new Set();
    const segments = [];
    for (let i = 0; i < snake.body.length; i++) {
      const segment = snake.body[i];
      const key = `${segment.x},${segment.y}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const conn = getCellConnections(segment, pathNeighbors);
      segments.push({ segment, conn, key });
    }

    if (selectionGlow) {
      const blurRadius = Math.max(6, cellSize * 0.5);
      ctx.save();
      ctx.filter = 'blur(' + blurRadius + 'px)';
      ctx.fillStyle = hexToRgba(selectionGlow, 1.0);
      for (let pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        for (const { segment, conn } of segments) {
          const sx = segment.x * cellSize;
          const sy = (boardHeight - 1 - segment.y) * cellSize;
          ctx.rect(sx + gap, sy + gap, cellSize - 2 * gap, cellSize - 2 * gap);
          if (conn.hasRight) ctx.rect(sx + cellSize - gap - 1, sy + gap, gap + 1, cellSize - 2 * gap);
          if (conn.hasLeft)  ctx.rect(sx, sy + gap, gap + 1, cellSize - 2 * gap);
          if (conn.hasTop)   ctx.rect(sx + gap, sy, cellSize - 2 * gap, gap + 1);
          if (conn.hasBottom) ctx.rect(sx + gap, sy + cellSize - gap - 1, cellSize - 2 * gap, gap + 1);
        }
        ctx.fill();
      }
      ctx.filter = 'none';
      ctx.restore();
    }

    if (invulnLevel !== 0) {
      const outerExpand = Math.max(2, cellSize * 0.06);
      const outerColor =
        invulnLevel < 0 ? "rgba(255, 40, 40, 1)" : "rgba(40, 120, 255, 1)";
      const lineWidth = Math.max(2, cellSize * 0.08);
      ctx.save();
      ctx.strokeStyle = outerColor;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "square";

      for (const { segment, conn } of segments) {
        const sx = segment.x * cellSize;
        const sy = (boardHeight - 1 - segment.y) * cellSize;
        const left = (conn.hasLeft ? sx : sx + gap) - outerExpand;
        const right =
          (conn.hasRight ? sx + cellSize : sx + cellSize - gap) + outerExpand;
        const top = (conn.hasTop ? sy : sy + gap) - outerExpand;
        const bottom =
          (conn.hasBottom ? sy + cellSize : sy + cellSize - gap) + outerExpand;

        if (!conn.hasTop) {
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(right, top);
          ctx.stroke();
        }
        if (!conn.hasBottom) {
          ctx.beginPath();
          ctx.moveTo(left, bottom);
          ctx.lineTo(right, bottom);
          ctx.stroke();
        }
        if (!conn.hasLeft) {
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(left, bottom);
          ctx.stroke();
        }
        if (!conn.hasRight) {
          ctx.beginPath();
          ctx.moveTo(right, top);
          ctx.lineTo(right, bottom);
          ctx.stroke();
        }

        if (conn.hasRight && conn.hasBottom) {
          const cx = sx + cellSize - gap + outerExpand;
          const cy = sy + cellSize - gap + outerExpand;
          ctx.beginPath();
          ctx.moveTo(cx - 2 * outerExpand, cy);
          ctx.lineTo(cx, cy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy - 2 * outerExpand);
          ctx.lineTo(cx, cy);
          ctx.stroke();
        }
        if (conn.hasRight && conn.hasTop) {
          const cx = sx + cellSize - gap + outerExpand;
          const cy = sy + gap - outerExpand;
          ctx.beginPath();
          ctx.moveTo(cx - 2 * outerExpand, cy);
          ctx.lineTo(cx, cy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx, cy + 2 * outerExpand);
          ctx.stroke();
        }
        if (conn.hasLeft && conn.hasBottom) {
          const cx = sx + gap - outerExpand;
          const cy = sy + cellSize - gap + outerExpand;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + 2 * outerExpand, cy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy - 2 * outerExpand);
          ctx.lineTo(cx, cy);
          ctx.stroke();
        }
        if (conn.hasLeft && conn.hasTop) {
          const cx = sx + gap - outerExpand;
          const cy = sy + gap - outerExpand;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + 2 * outerExpand, cy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx, cy + 2 * outerExpand);
          ctx.stroke();
        }
      }
      ctx.lineCap = "butt";
      ctx.restore();
    }

    if (ghost) {
      // Dead snake: same continuous body shape as a live snake, but the solid
      // fill is replaced by diagonal stripes in the team color, slanted the
      // opposite way ("\") to the fertile-ground stripes ("/").
      ctx.save();
      ctx.beginPath();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const { segment, conn } of segments) {
        const sx = segment.x * cellSize;
        const sy = (boardHeight - 1 - segment.y) * cellSize;
        ctx.rect(sx + gap, sy + gap, cellSize - 2 * gap, cellSize - 2 * gap);
        if (conn.hasRight)
          ctx.rect(sx + cellSize - gap - 1, sy + gap, gap + 1, cellSize - 2 * gap);
        if (conn.hasLeft) ctx.rect(sx, sy + gap, gap + 1, cellSize - 2 * gap);
        if (conn.hasTop) ctx.rect(sx + gap, sy, cellSize - 2 * gap, gap + 1);
        if (conn.hasBottom)
          ctx.rect(sx + gap, sy + cellSize - gap - 1, cellSize - 2 * gap, gap + 1);
        if (sx < minX) minX = sx;
        if (sy < minY) minY = sy;
        if (sx + cellSize > maxX) maxX = sx + cellSize;
        if (sy + cellSize > maxY) maxY = sy + cellSize;
      }
      ctx.clip();
      const bh = maxY - minY;
      const bw = maxX - minX;
      ctx.strokeStyle = hexToRgba(snakeColor, 0.95);
      ctx.lineWidth = Math.max(1.5, cellSize / 7);
      const stripeSpacing = Math.max(4, cellSize / 3.5);
      for (let o = -bh; o <= bw; o += stripeSpacing) {
        ctx.beginPath();
        ctx.moveTo(minX + o, minY);
        ctx.lineTo(minX + o + bh, minY + bh);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.fillStyle = snakeColor;
      for (const { segment, conn } of segments) {
        const sx = segment.x * cellSize;
        const sy = (boardHeight - 1 - segment.y) * cellSize;
        ctx.fillRect(sx + gap, sy + gap, cellSize - 2 * gap, cellSize - 2 * gap);
        if (conn.hasRight)
          ctx.fillRect(
            sx + cellSize - gap - 1,
            sy + gap,
            gap + 1,
            cellSize - 2 * gap,
          );
        if (conn.hasLeft) ctx.fillRect(sx, sy + gap, gap + 1, cellSize - 2 * gap);
        if (conn.hasTop) ctx.fillRect(sx + gap, sy, cellSize - 2 * gap, gap + 1);
        if (conn.hasBottom)
          ctx.fillRect(
            sx + gap,
            sy + cellSize - gap - 1,
            cellSize - 2 * gap,
            gap + 1,
          );
      }
    }

    if (isControlled) {
      const innerInset = Math.max(1, cellSize * 0.04);
      const dashLen = Math.max(2, cellSize * 0.1);
      ctx.save();
      ctx.strokeStyle = "#FFD700";
      ctx.lineWidth = Math.max(1.5, cellSize * 0.05);
      ctx.setLineDash([dashLen, dashLen]);
      ctx.lineCap = "square";

      for (const { segment, conn } of segments) {
        const sx = segment.x * cellSize;
        const sy = (boardHeight - 1 - segment.y) * cellSize;
        const left = (conn.hasLeft ? sx : sx + gap) + innerInset;
        const right =
          (conn.hasRight ? sx + cellSize : sx + cellSize - gap) - innerInset;
        const top = (conn.hasTop ? sy : sy + gap) + innerInset;
        const bottom =
          (conn.hasBottom ? sy + cellSize : sy + cellSize - gap) - innerInset;

        if (!conn.hasTop) {
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(right, top);
          ctx.stroke();
        }
        if (!conn.hasBottom) {
          ctx.beginPath();
          ctx.moveTo(left, bottom);
          ctx.lineTo(right, bottom);
          ctx.stroke();
        }
        if (!conn.hasLeft) {
          ctx.beginPath();
          ctx.moveTo(left, top);
          ctx.lineTo(left, bottom);
          ctx.stroke();
        }
        if (!conn.hasRight) {
          ctx.beginPath();
          ctx.moveTo(right, top);
          ctx.lineTo(right, bottom);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.lineCap = "butt";
      ctx.restore();
    }
  }

  function processMoveEvaluations(
    moveEvaluations,
    safeMoves,
    head,
    chosenMove,
  ) {
    const moveState = {
      selectedMove: null,
      moves: {},
      safeMoves: safeMoves || [],
      territoryCells: {},
      selectedSnake: null,
    };

    const directions = ["up", "down", "left", "right"];
    const evaluationsMap = {};

    let evaluationsArray = [];
    if (moveEvaluations) {
      if (Array.isArray(moveEvaluations)) {
        evaluationsArray = moveEvaluations;
      } else if (moveEvaluations.evaluations) {
        evaluationsArray = moveEvaluations.evaluations;
        moveState.territoryCells = moveEvaluations.territoryCells || {};
      }
    }

    evaluationsArray.forEach((evalData) => {
      evaluationsMap[evalData.move] = evalData;
    });

    directions.forEach((direction) => {
      let candidatePos = null;
      switch (direction) {
        case "up":
          candidatePos = { x: head.x, y: head.y + 1 };
          break;
        case "down":
          candidatePos = { x: head.x, y: head.y - 1 };
          break;
        case "left":
          candidatePos = { x: head.x - 1, y: head.y };
          break;
        case "right":
          candidatePos = { x: head.x + 1, y: head.y };
          break;
      }

      const isSafe = moveState.safeMoves.includes(direction);
      const evalData = evaluationsMap[direction];

      moveState.moves[direction] = {
        direction: direction,
        position: candidatePos,
        positionKey: candidatePos
          ? `${candidatePos.x},${candidatePos.y}`
          : null,
        isSafe: isSafe,
        isChosen: direction === chosenMove,
        isEvaluated: !!evalData,
        score: evalData?.score ?? null,
        breakdown: evalData?.breakdown ?? null,
        numStates: evalData?.numStates ?? null,
        displayScore: evalData?.score ?? (isSafe ? 0 : null),
        projectedTerritoryCells: evalData?.projectedTerritoryCells ?? null,
        quality: null,
        color: null,
      };
    });

    const scoredMoves = Object.values(moveState.moves).filter(
      (m) => m.displayScore != null,
    );
    const allScores = scoredMoves.map((m) => m.displayScore);

    Object.values(moveState.moves).forEach((move) => {
      if (move.displayScore != null && allScores.length > 0) {
        move.quality = getMoveQuality(move.displayScore, allScores);
        move.color = getScoreColor(move.displayScore, allScores);
      } else {
        move.quality = "not-evaluated";
        move.color = "rgba(100, 100, 100, 0.3)";
      }
    });

    return moveState;
  }

  function renderBoard(canvas, gameState, moveState, options) {
    const ctx = canvas.getContext("2d");
    const snakeId = options?.snakeId || null;
    const chosenMove = options?.chosenMove || null;
    const showChosenArrow = options?.showChosenArrow !== false;
    // Interactive (live) vs read-only (historic) rendering. Defaults to true so
    // existing callers are unchanged. When false, control-only overlays such as
    // server-staged move arrows are suppressed — the historic/readonly play view
    // and the Game History viewer render the board, candidate cells, and the
    // logged chosen-move arrow, but never live staging affordances.
    const interactive = options?.interactive !== false;

    if (!gameState || !gameState.board) return;

    const board = gameState.board;
    const cellSize = Math.min(
      canvas.width / board.width,
      canvas.height / board.height,
    );
    const boardW = board.width * cellSize;
    const boardH = board.height * cellSize;
    const turn = gameState.turn || 0;

    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    for (let x = 0; x <= board.width; x++) {
      const px = Math.floor(x * cellSize) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, boardH);
      ctx.stroke();
    }
    for (let y = 0; y <= board.height; y++) {
      const py = Math.floor(y * cellSize) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(boardW, py);
      ctx.stroke();
    }

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, boardW - 2, boardH - 2);

    if (board.hazards && board.hazards.length > 0) {
      board.hazards.forEach((hazard) => {
        const x = hazard.x * cellSize;
        const y = (board.height - 1 - hazard.y) * cellSize;
        ctx.save();
        ctx.fillStyle = "#dc1e1e";
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.restore();
      });
    }

    if (board.fertileTiles && board.fertileTiles.length > 0) {
      board.fertileTiles.forEach((tile) => {
        const x = tile.x * cellSize;
        const y = (board.height - 1 - tile.y) * cellSize;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cellSize, cellSize);
        ctx.clip();
        ctx.strokeStyle = "rgba(240, 198, 70, 0.85)";
        ctx.lineWidth = Math.max(1.5, cellSize / 7);
        const stripeSpacing = Math.max(4, cellSize / 3.5);
        for (let offset = 0; offset <= cellSize * 2; offset += stripeSpacing) {
          ctx.beginPath();
          ctx.moveTo(x + offset, y);
          ctx.lineTo(x + offset - cellSize, y + cellSize);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    if (moveState) {
      let activeTerritoryForDisplay = moveState.territoryCells;
      if (
        moveState.selectedMove &&
        moveState.moves[moveState.selectedMove]?.projectedTerritoryCells
      ) {
        activeTerritoryForDisplay =
          moveState.moves[moveState.selectedMove].projectedTerritoryCells;
      }
      if (
        activeTerritoryForDisplay &&
        Object.keys(activeTerritoryForDisplay).length > 0
      ) {
        const snakeColorMap = {};
        const bodyOwnerMap = {};
        board.snakes.forEach((snake) => {
          snakeColorMap[snake.id] =
            snake.customizations?.color || snake.color || "#888888";
          snake.body.forEach((seg) => {
            bodyOwnerMap[`${seg.x},${seg.y}`] = snake.id;
          });
        });
        renderTerritoryBoundaries(
          ctx,
          activeTerritoryForDisplay,
          snakeColorMap,
          board.height,
          cellSize,
          moveState.selectedSnake,
          bodyOwnerMap,
        );
      }
    }

    if (moveState) {
      Object.values(moveState.moves).forEach((move) => {
        if (move.position && (move.isSafe || move.isEvaluated)) {
          const x = move.position.x * cellSize;
          const y = (board.height - 1 - move.position.y) * cellSize;
          ctx.fillStyle = move.color;
          ctx.fillRect(x, y, cellSize, cellSize);
          if (moveState.selectedMove === move.direction) {
            ctx.strokeStyle = "#9C27B0";
            ctx.lineWidth = 3;
            ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
          }
        }
      });
    }

    board.food.forEach((food) => {
      const x = food.x * cellSize;
      const y = (board.height - 1 - food.y) * cellSize;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cellSize, cellSize);
      ctx.clip();
      ctx.fillStyle = "#000000";
      const emojiSize = Math.max(cellSize * 0.7, 10);
      ctx.font = `${emojiSize}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u{1F383}", x + cellSize / 2, y + cellSize / 2);
      ctx.restore();
    });

    if (
      board.invulnerabilityPotions &&
      board.invulnerabilityPotions.length > 0
    ) {
      board.invulnerabilityPotions.forEach((potion) => {
        const x = potion.x * cellSize;
        const y = (board.height - 1 - potion.y) * cellSize;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cellSize, cellSize);
        ctx.clip();
        if (_potionImage) {
          const pad = cellSize * 0.1;
          ctx.drawImage(
            _potionImage,
            x + pad,
            y + pad,
            cellSize - pad * 2,
            cellSize - pad * 2,
          );
        } else {
          const emojiSize = Math.max(cellSize * 0.7, 10);
          ctx.font = `${emojiSize}px serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("\u{1F9EA}", x + cellSize / 2, y + cellSize / 2);
        }
        ctx.restore();
      });
    }

    const controlledSnakeIds = options?.controlledSnakeIds || new Set();
    const selectionGlows = options?.selectionGlows || {};

    board.snakes.forEach((snake) => {
      const isControlled = controlledSnakeIds.has
        ? controlledSnakeIds.has(snake.id)
        : !!controlledSnakeIds[snake.id];
      const glowColor = selectionGlows[snake.id] || null;
      renderSnakeUnified(ctx, snake, board.height, cellSize, {
        selectionGlow: glowColor,
        isControlled: isControlled,
      });
    });

    board.snakes.forEach((snake) => {
      const head = snake.body[0];
      if (head) {
        const hx = head.x * cellSize;
        const hy = (board.height - 1 - head.y) * cellSize;
        ctx.save();
        ctx.beginPath();
        ctx.rect(hx, hy, cellSize, cellSize);
        ctx.clip();
        const headEmojiSize = Math.max(cellSize * 0.55, 8);
        ctx.font = `${headEmojiSize}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(
          snake.emoji || "\u{1F40D}",
          hx + cellSize / 2,
          hy + cellSize / 2,
        );
        ctx.restore();
      }

      if (turn > 0 && snake.body.length > 1) {
        const labelSize = Math.max(cellSize * 0.55, 10);
        const holdsMap = options?.holds || {};
        const holdCount = holdsMap[snake.id] || 0;

        const neck = snake.body[1];
        if (neck) {
          const nx = neck.x * cellSize + cellSize / 2;
          const ny = (board.height - 1 - neck.y) * cellSize + cellSize / 2;
          ctx.font = `${labelSize}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#000000";
          const lengthLabel = holdCount > 0
            ? `${snake.body.length} (H${holdCount})`
            : String(snake.body.length);
          ctx.fillText(lengthLabel, nx, ny);
        }

        const willGrow =
          snake.body[snake.body.length - 1].x ===
            snake.body[snake.body.length - 2].x &&
          snake.body[snake.body.length - 1].y ===
            snake.body[snake.body.length - 2].y;
        if (willGrow) {
          const tail = snake.body[snake.body.length - 1];
          const tx = tail.x * cellSize + cellSize / 2;
          const ty = (board.height - 1 - tail.y) * cellSize + cellSize / 2;
          ctx.font = `${labelSize}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#000000";
          ctx.fillText("2", tx, ty);
        }
      }

      const stagedMoves = options?.stagedMoves || {};
      const stagedForThisSnake = stagedMoves[snake.id];
      let arrowMove = null;
      let arrowColor = "#4CAF50";
      let arrowCommitted = false;
      // Replay styling (options.chosenMoveStyle):
      //   'submitted' (default)   — solid arrow: the move actually sent to the
      //                             game server (ground truth).
      //   'recommendation-only'   — dashed grey arrow: no submitted_move was
      //                             logged for this row, so the arrow shows the
      //                             bot's recommendation only.
      // options.secondaryMove — a thin dashed grey hint arrow for the bot's
      // recommendation when it differs from the submitted move.
      let arrowDashed = false;
      let secondaryMove = null;
      if (showChosenArrow && snake.id === snakeId && chosenMove) {
        arrowMove = chosenMove;
        if (options?.chosenMoveStyle === "recommendation-only") {
          arrowColor = "#9E9E9E";
          arrowDashed = true;
        }
        secondaryMove = options?.secondaryMove || null;
      } else if (interactive && stagedForThisSnake) {
        arrowMove = stagedForThisSnake.move;
        arrowColor = stagedForThisSnake.color || "#4CAF50";
        arrowCommitted = !!stagedForThisSnake.committed;
      }
      if (arrowMove) {
        const shead = snake.body[0];
        if (shead) {
          const x = shead.x * cellSize;
          const y = (board.height - 1 - shead.y) * cellSize;
          const centerX = x + cellSize / 2;
          const centerY = y + cellSize / 2;
          const arrowLen = cellSize * 1.2;
          const endpointFor = (move) => {
            let ex = centerX;
            let ey = centerY;
            switch (move) {
              case "up":
                ey -= arrowLen;
                break;
              case "down":
                ey += arrowLen;
                break;
              case "left":
                ex -= arrowLen;
                break;
              case "right":
                ex += arrowLen;
                break;
            }
            return { ex, ey };
          };
          const drawArrow = (move, color, lineWidth, dashed, headScale, chevrons) => {
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = lineWidth;
            ctx.setLineDash(dashed ? [lineWidth * 1.6, lineWidth * 1.4] : []);
            const { ex, ey } = endpointFor(move);
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(ex, ey);
            ctx.stroke();
            ctx.setLineDash([]);
            const angle = Math.atan2(ey - centerY, ex - centerX);
            const headSize = Math.max(cellSize * 0.45, 18) * headScale;
            const drawHead = (tipX, tipY) => {
              ctx.beginPath();
              ctx.moveTo(tipX, tipY);
              ctx.lineTo(
                tipX - headSize * Math.cos(angle - Math.PI / 6),
                tipY - headSize * Math.sin(angle - Math.PI / 6),
              );
              ctx.lineTo(
                tipX - headSize * Math.cos(angle + Math.PI / 6),
                tipY - headSize * Math.sin(angle + Math.PI / 6),
              );
              ctx.closePath();
              ctx.fill();
            };
            drawHead(ex, ey);
            if (chevrons > 1) {
              const back = headSize * 0.7;
              drawHead(ex - back * Math.cos(angle), ey - back * Math.sin(angle));
            }
            return { ex, ey };
          };

          // Secondary bot-recommendation hint FIRST so the primary draws over it.
          if (secondaryMove && secondaryMove !== arrowMove) {
            drawArrow(secondaryMove, "#9E9E9E", Math.max(cellSize * 0.08, 3), true, 0.6, 1);
          }

          // Staged and committed arrows share the same color (grey for the
          // bot, the controller's color for a human). The ONLY visual
          // difference is the arrowhead count: a staged move draws a single
          // chevron, a committed move a double chevron.
          const { ex: endX, ey: endY } = drawArrow(
            arrowMove,
            arrowColor,
            Math.max(cellSize * 0.18, 6),
            arrowDashed,
            1,
            arrowCommitted ? 2 : 1,
          );

          // Fatal-move warning: the staged/committed move walks the head into
          // certain death (wall, own body, or a non-severable enemy). The move
          // is NEVER auto-corrected — the server commits it verbatim — so we
          // mark the destination cell with a red ⃠ (no-entry circle + X) to warn
          // the human. We keep the arrow's source colour intact so the warning
          // is additive, not a replacement.
          // options.fatalConsented (replay): this turn's submitted move went
          // through the fatal-move confirmation dialog — flag it with the same
          // red no-entry marker so a deliberate death is visible in review.
          if ((stagedForThisSnake && stagedForThisSnake.fatal) || options?.fatalConsented) {
            let dcx = 0, dcy = 0;
            switch (arrowMove) {
              case "up": dcy = 1; break;
              case "down": dcy = -1; break;
              case "left": dcx = -1; break;
              case "right": dcx = 1; break;
            }
            const destCol = shead.x + dcx;
            const destRow = board.height - 1 - (shead.y + dcy);
            const mx = destCol * cellSize + cellSize / 2;
            const my = destRow * cellSize + cellSize / 2;
            const r = cellSize * 0.32;
            ctx.setLineDash([]);
            ctx.lineWidth = Math.max(cellSize * 0.1, 3);
            ctx.strokeStyle = "#ff1744";
            ctx.beginPath();
            ctx.arc(mx, my, r, 0, Math.PI * 2);
            ctx.stroke();
            const d = r * 0.6;
            ctx.beginPath();
            ctx.moveTo(mx - d, my - d);
            ctx.lineTo(mx + d, my + d);
            ctx.moveTo(mx + d, my - d);
            ctx.lineTo(mx - d, my + d);
            ctx.stroke();
          }
        }
      }
    });

    // Dead-head markers (drawn last so they sit on top of live snakes). This is
    // the SINGLE centralized death-rendering path shared by live play, /play
    // historic scrubbing, and /history. We build one unified list of death
    // entries, then derive each snake's authoritative final cell + intended
    // (staged) cell the same way for every consumer:
    //   - `actual` (solid marker): the server-decided final cell. Taken from an
    //     explicit actualHead (history: last-known head stepped by server_move)
    //     when present, else derived from the engine's authoritative `lastMoves`
    //     map (last-known head stepped one cell in the recorded direction). Same
    //     source for our snakes and enemies.
    //   - `intended` (shadow marker): the move we actually submitted. Taken from
    //     an explicit intendedHead (history: last-known head stepped by
    //     submitted_move) when present, else the `submittedMoves` map (live:
    //     client-tracked committed move), else the staged-move map. Only drawn
    //     when it differs from the server-decided cell.
    //   - When neither an explicit actualHead nor `lastMoves` is available
    //     (older logs, or the game's terminal move with no following state),
    //     fall back to the "unknown ?" marker at the last-known head.
    const ourDeaths = options?.ourDeaths || [];
    const excludeIds = new Set(
      ourDeaths.map((d) => d.id).filter((id) => id != null),
    );
    let deadSnakes = options?.deadSnakes || null;
    if (!deadSnakes && options?.previousBoard) {
      deadSnakes = getDisappearedSnakes(
        options.previousBoard.snakes,
        board.snakes,
        excludeIds,
      );
    }
    // The authoritative move map rides along on the rendered game state (it is
    // logged inside game_state JSONB, so historic scrubbing and /history get it
    // for free); an explicit option can override it.
    const lastMoves = options?.lastMoves || gameState?.lastMoves || null;
    const stagedMovesForDeaths = options?.stagedMoves || null;
    // Live: the client tracks the move it actually committed per snake ({id: move}).
    // A dead snake is gone from the server's staged-move broadcast, so this map is
    // the only source for its intended (ghost) cell.
    const submittedMovesForDeaths = options?.submittedMoves || null;

    const deathEntries = [];
    if (deadSnakes) {
      deadSnakes.forEach((d) => {
        deathEntries.push({
          id: d.id,
          lastHead: d.head,
          body: d.body,
          color: d.color,
          intendedHead: undefined,
          actualHead: undefined,
        });
      });
    }
    ourDeaths.forEach((d) => {
      deathEntries.push({
        id: d.id,
        lastHead: d.lastHead || d.intendedHead || null,
        body: d.body || null,
        color: d.color,
        intendedHead: d.intendedHead,
        actualHead: d.actualHead,
      });
    });

    deathEntries.forEach((d) => {
      // Ghosted last-known body so the dead snake still reads on the board.
      if (d.body)
        renderSnakeUnified(
          ctx,
          { body: d.body, color: d.color },
          board.height,
          cellSize,
          { ghost: true },
        );

      // Authoritative final cell: explicit override first, else lastMoves.
      let actual = d.actualHead || null;
      if (!actual && lastMoves && d.id != null && d.lastHead) {
        actual = applyDirection(d.lastHead, lastMoves[d.id]);
      }
      // Intended/submitted cell: explicit override first, else the live
      // committed-move map, else the staged-move map.
      let intended = d.intendedHead || null;
      if (!intended && submittedMovesForDeaths && d.id != null && d.lastHead) {
        const submitted = submittedMovesForDeaths[d.id];
        if (submitted) {
          intended = applyDirection(d.lastHead, submitted);
        }
      }
      if (!intended && stagedMovesForDeaths && d.id != null && d.lastHead) {
        const staged = stagedMovesForDeaths[d.id];
        if (staged && staged.move) {
          intended = applyDirection(d.lastHead, staged.move);
        }
      }

      const same =
        intended &&
        actual &&
        intended.x === actual.x &&
        intended.y === actual.y;
      if (intended && !same) {
        drawDeathMarker(ctx, intended, board.height, cellSize, d.color, true);
      }
      if (actual) {
        // Authoritative final head → solid marker.
        drawDeathMarker(ctx, actual, board.height, cellSize, d.color, false);
      } else {
        // No authoritative final position (older logs / no lastMoves) → "?"
        // marker at the last-known head.
        drawUnknownDeathMarker(
          ctx,
          d.lastHead || intended,
          board.height,
          cellSize,
          d.color,
        );
      }
    });

    return cellSize;
  }

  function createBoardOverlay(
    overlayEl,
    canvas,
    board,
    moveState,
    onCellClick,
  ) {
    overlayEl.innerHTML = "";
    const displayWidth = canvas.clientWidth || canvas.width;
    const displayHeight = canvas.clientHeight || canvas.height;
    overlayEl.style.width = displayWidth + "px";
    overlayEl.style.height = displayHeight + "px";
    overlayEl.style.left = canvas.offsetLeft + "px";
    overlayEl.style.top = canvas.offsetTop + "px";
    const displayCellSize = Math.min(
      displayWidth / board.width,
      displayHeight / board.height,
    );

    Object.values(moveState.moves).forEach((move) => {
      if (!move.position) return;
      const button = document.createElement("button");
      button.className = "cell-button";
      if (move.isSafe) button.className += " candidate";
      if (moveState.selectedMove === move.direction)
        button.className += " selected";

      const x = move.position.x * displayCellSize;
      const y = (board.height - 1 - move.position.y) * displayCellSize;
      button.style.left = x + "px";
      button.style.top = y + "px";
      button.style.width = displayCellSize + "px";
      button.style.height = displayCellSize + "px";
      button.style.zIndex = "10";

      button.onclick = (e) => {
        e.stopPropagation();
        onCellClick(move.direction, e);
      };
      const scoreText =
        move.score != null
          ? move.score.toFixed(2)
          : move.isSafe
            ? "0.00"
            : "N/A";
      button.title = `${move.direction.toUpperCase()} - Score: ${scoreText}`;
      overlayEl.appendChild(button);
    });
  }

  // Single source of truth for team identity on the client, mirroring the
  // server-side TeamDetector rule: squad → color → snake id.
  function getTeamKey(snake) {
    if (!snake) return "";
    return snake.squad || snake.customizations?.color || snake.color || snake.id;
  }

  // Turns a raw game-server team id like "team_red" into a friendly label
  // ("Team Red"). Returns null when there's nothing usable.
  function prettifyTeamName(teamId) {
    if (!teamId || !String(teamId).trim()) return null;
    return String(teamId)
      .trim()
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // Friendly display name for a team given one of its snakes: game-server team
  // name first, then squad, then color, then a generic fallback.
  function teamDisplayName(snake) {
    return (
      prettifyTeamName(snake?.teamID) ||
      snake?.squad ||
      snake?.customizations?.color ||
      snake?.color ||
      "Team"
    );
  }

  // Builds the HTML for one snake row. `opts` controls history-viewer extras:
  // selectable (clickable to switch perspective) and active (current
  // perspective). Without opts it renders the plain play-page row.
  function renderSnakeInfoItem(snake, ourSnakeId, holdsMap, opts, currentTurn) {
    const isOurSnake = snake.id === ourSnakeId;
    const isDead = !!(opts && opts.dead);
    const snakeColor = snake.customizations?.color || snake.color || "#888888";
    const invulnLevel = snake.invulnerabilityLevel || 0;
    let invulnDisplay = "";
    if (invulnLevel !== 0) {
      const icon = invulnLevel > 0 ? "\u{1F6E1}\uFE0F" : "\u26A0\uFE0F";
      // Turns remaining (inclusive of the current turn) from the absolute expiry
      // turn supplied by the server. Falls back to just the level when the expiry
      // is missing (older logs) or already passed at the displayed turn.
      const expiry = snake.invulnerabilityExpiryTurn;
      let turnsSuffix = "";
      if (typeof expiry === "number" && typeof currentTurn === "number") {
        const remaining = expiry - currentTurn + 1;
        if (remaining >= 1) turnsSuffix = ` \u00B7 ${remaining}t`;
      }
      invulnDisplay = `<span>${icon} ${invulnLevel}${turnsSuffix}</span>`;
    }
    const emojiDisplay = snake.emoji || "\u{1F40D}";
    const holdCount = holdsMap[snake.id] || 0;
    const holdBadge = holdCount > 0
      ? `<span style="background:#ff9800;color:#fff;padding:1px 6px;border-radius:8px;font-weight:700;">HOLD ${holdCount}</span>`
      : "";
    const selectable = opts && opts.selectable;
    const active = opts && opts.active;
    const itemClass =
      "snake-info-item" +
      (selectable ? " selectable" : "") +
      (active ? " active-perspective" : "");
    const styleParts = [];
    if (selectable) styleParts.push("cursor:pointer;");
    if (isDead) styleParts.push("opacity:0.45;filter:grayscale(0.6);");
    const clickAttr =
      (selectable ? ` data-select-snake="${snake.id}"` : "") +
      (styleParts.length ? ` style="${styleParts.join("")}"` : "");
    const deadSuffix = isDead
      ? ' <span style="color:#aaa;font-weight:400;">(dead)</span>'
      : "";
    return `
        <div class="${itemClass}"${clickAttr}>
          <div class="snake-color-box" style="background-color: ${snakeColor};"></div>
          <div class="snake-details">
            <div class="snake-name">${emojiDisplay} ${snake.name}${isOurSnake ? " (You)" : ""}${deadSuffix}</div>
            <div class="snake-id" style="font-size: 0.75em; color: #888; margin-top: 1px;">${snake.id}</div>
            <div class="snake-stats">
              <span>\u{1F4CF} ${snake.body.length}</span>
              ${invulnDisplay}
              ${holdBadge}
            </div>
          </div>
        </div>
      `;
  }

  // Renders the participants list. With options.groupByTeam the snakes are
  // grouped by team (our team first and visually distinguished), and our team's
  // snakes are made selectable via options.onSelectSnake so the history viewer
  // can switch perspective. Without options it falls back to the flat list used
  // by the live play page.
  function renderSnakeInfo(container, gameState, ourSnakeId, holds, options) {
    if (!gameState || !gameState.board) {
      container.innerHTML = "";
      return;
    }
    const holdsMap = holds || {};
    const snakes = gameState.board.snakes;
    const currentTurn = gameState.turn;
    // Dead snakes (options.deadSnakes) are appended to their team groups so the
    // roster always shows every snake ever seen, greyed out with final length.
    const boardIds = new Set(snakes.map((s) => s.id));
    const deadSnakes = ((options && options.deadSnakes) || []).filter(
      (s) => !boardIds.has(s.id),
    );
    const deadIds = new Set(deadSnakes.map((s) => s.id));
    const allSnakes = snakes.concat(deadSnakes);

    if (!options || !options.groupByTeam) {
      container.innerHTML = allSnakes
        .map((snake) =>
          renderSnakeInfoItem(
            snake, ourSnakeId, holdsMap,
            deadIds.has(snake.id) ? { dead: true } : null, currentTurn,
          ),
        )
        .join("");
      return;
    }

    // Group snakes by team key.
    const teams = new Map();
    for (const snake of allSnakes) {
      const key = getTeamKey(snake);
      if (!teams.has(key)) teams.set(key, []);
      teams.get(key).push(snake);
    }

    const selectableIds = options.selectableSnakeIds || null;
    const canSelect = !!options.onSelectSnake;
    // Identify our team even when there is no perspective snake set (e.g. live
    // play with nothing selected yet) by falling back to any selectable snake.
    const ourSnake =
      allSnakes.find((s) => s.id === ourSnakeId) ||
      (selectableIds ? allSnakes.find((s) => selectableIds.has(s.id)) : null);
    const ourTeamKey = ourSnake ? getTeamKey(ourSnake) : null;

    // Our team first, then enemy teams.
    const orderedKeys = Array.from(teams.keys()).sort((a, b) => {
      if (a === ourTeamKey) return -1;
      if (b === ourTeamKey) return 1;
      return 0;
    });

    const html = orderedKeys
      .map((key) => {
        const teamSnakes = teams.get(key);
        const isOurTeam = key === ourTeamKey;
        const teamColor =
          teamSnakes[0].customizations?.color ||
          teamSnakes[0].color ||
          "#888888";
        const name = teamDisplayName(teamSnakes[0]);
        const label = isOurTeam ? `${name} (Our Team)` : name;
        const headerClass = isOurTeam
          ? "team-group-header our-team"
          : "team-group-header enemy-team";
        const items = teamSnakes
          .map((snake) =>
            renderSnakeInfoItem(snake, ourSnakeId, holdsMap, {
              selectable:
                canSelect &&
                isOurTeam &&
                (selectableIds ? selectableIds.has(snake.id) : !deadIds.has(snake.id)),
              active: snake.id === ourSnakeId,
              dead: deadIds.has(snake.id),
            }, currentTurn),
          )
          .join("");
        return `
        <div class="team-group ${isOurTeam ? "our-team" : "enemy-team"}">
          <div class="${headerClass}">
            <span class="team-group-swatch" style="background-color:${teamColor};"></span>
            <span>${label}</span>
          </div>
          ${items}
        </div>
      `;
      })
      .join("");

    container.innerHTML = html;

    if (options.onSelectSnake) {
      container.querySelectorAll("[data-select-snake]").forEach((el) => {
        el.addEventListener("click", () => {
          options.onSelectSnake(el.getAttribute("data-select-snake"));
        });
      });
    }
  }

  function renderMoveButtons(container, moveState, onMoveClick) {
    const buttonLayout = [null, "up", null, "left", "down", "right"];

    container.innerHTML = buttonLayout
      .map((direction) => {
        if (!direction) {
          return '<div style="grid-column: span 1;"></div>';
        }
        const move = moveState.moves[direction];
        if (!move) return "";

        let classes = ["move-button"];
        if (move.isChosen) classes.push("chosen");
        if (moveState.selectedMove === direction) classes.push("selected");

        const scoreText =
          move.score != null
            ? `Score: ${move.score.toFixed(2)}`
            : move.isSafe
              ? "Score: 0.00"
              : "Not evaluated";

        const bgColor = move.color || "rgba(100, 100, 100, 0.3)";
        const solidColor = bgColor.replace("0.3)", "0.8)");

        return `
        <button class="${classes.join(" ")}"
                onclick="BoardRenderer._moveClickHandler('${direction}')"
                style="background: ${solidColor};">
          ${direction.toUpperCase()} ${move.isChosen ? "\u2713" : ""}
          <span class="score">${scoreText}</span>
        </button>
      `;
      })
      .join("");

    BoardRenderer._moveClickHandler = onMoveClick;
  }

  function updateStatsTable(tbody, move, moveState) {
    if (!move || !move.breakdown) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: #888;">Select a move to see breakdown</td>
        </tr>
      `;
      return;
    }

    const breakdown = move.breakdown;
    const candidateMoves = Object.values(moveState.moves).filter(
      (m) => m.isEvaluated || m.isSafe,
    );
    const averageWeighted = {};

    if (candidateMoves.length > 0) {
      const weightedSums = {
        myLengthScore: 0,
        myTerritoryScore: 0,
        myControlledFoodScore: 0,
        myControlledFertileScore: 0,
        teamLengthScore: 0,
        teamTerritoryScore: 0,
        teamControlledFoodScore: 0,
        foodProximityScore: 0,
        foodEatenScore: 0,
        enemyTerritoryScore: 0,
        enemyLengthScore: 0,
        edgePenaltyScore: 0,
        selfSpaceScore: 0,
        alliesEnoughSpaceScore: 0,
        opponentsEnoughSpaceScore: 0,
        killsScore: 0,
        deathsScore: 0,
        enemyH2HRiskScore: 0,
        allyH2HRiskScore: 0,
        waypointGotoScore: 0,
        waypointNearScore: 0,
        aggressionScore: 0,
        trappedScore: 0,
        fertileScore: 0,
      };

      candidateMoves.forEach((candidateMove) => {
        if (candidateMove.breakdown?.weighted) {
          const weighted = candidateMove.breakdown.weighted;
          for (const key in weightedSums) {
            weightedSums[key] += weighted[key] ?? 0;
          }
        }
      });

      const count = candidateMoves.length;
      for (const key in weightedSums) {
        averageWeighted[key] = weightedSums[key] / count;
      }
    }

    function formatValue(value) {
      if (typeof value === "number") {
        if (Number.isInteger(value)) return value.toString();
        return value.toFixed(2);
      }
      return value;
    }

    const metricsConfig = [
      {
        name: "My Length",
        value: breakdown.myLength ?? 0,
        weight: breakdown.weights?.myLength ?? 10,
        weightedScore: breakdown.weighted?.myLengthScore ?? 0,
        averageWeighted: averageWeighted.myLengthScore ?? 0,
      },
      {
        name: "My Territory",
        value: breakdown.myTerritory ?? 0,
        weight: breakdown.weights?.myTerritory ?? 1,
        weightedScore: breakdown.weighted?.myTerritoryScore ?? 0,
        averageWeighted: averageWeighted.myTerritoryScore ?? 0,
      },
      {
        name: "My Controlled Food",
        value: breakdown.myControlledFood ?? breakdown.myFoodCount ?? 0,
        weight: breakdown.weights?.myControlledFood ?? 10,
        weightedScore: breakdown.weighted?.myControlledFoodScore ?? 0,
        averageWeighted: averageWeighted.myControlledFoodScore ?? 0,
      },
      {
        name: "My Fertile Ground",
        value: breakdown.myControlledFertile ?? 0,
        weight: breakdown.weights?.myControlledFertile ?? 2,
        weightedScore: breakdown.weighted?.myControlledFertileScore ?? 0,
        averageWeighted: averageWeighted.myControlledFertileScore ?? 0,
      },
      {
        name: "Team Length",
        value: breakdown.teamLength ?? 0,
        weight: breakdown.weights?.teamLength ?? 10,
        weightedScore: breakdown.weighted?.teamLengthScore ?? 0,
        averageWeighted: averageWeighted.teamLengthScore ?? 0,
      },
      {
        name: "Team Territory",
        value: breakdown.teamTerritory ?? 0,
        weight: breakdown.weights?.teamTerritory ?? 1,
        weightedScore: breakdown.weighted?.teamTerritoryScore ?? 0,
        averageWeighted: averageWeighted.teamTerritoryScore ?? 0,
      },
      {
        name: "Team Controlled Food",
        value: breakdown.teamControlledFood ?? breakdown.teamFoodCount ?? 0,
        weight: breakdown.weights?.teamControlledFood ?? 10,
        weightedScore: breakdown.weighted?.teamControlledFoodScore ?? 0,
        averageWeighted: averageWeighted.teamControlledFoodScore ?? 0,
      },
      {
        name: "Food Distance",
        value: breakdown.foodDistance ?? "N/A",
        weight: 0,
        weightedScore: 0,
        averageWeighted: 0,
      },
      {
        name: "Food Proximity",
        value: breakdown.foodProximity ?? breakdown.foodDistanceInverse ?? 0,
        weight: breakdown.weights?.foodProximity ?? 50,
        weightedScore: breakdown.weighted?.foodProximityScore ?? 0,
        averageWeighted: averageWeighted.foodProximityScore ?? 0,
      },
      {
        name: "Food Eaten",
        value: breakdown.foodEaten ?? 0,
        weight: breakdown.weights?.foodEaten ?? 200,
        weightedScore: breakdown.weighted?.foodEatenScore ?? 0,
        averageWeighted: averageWeighted.foodEatenScore ?? 0,
      },
      {
        name: "Enemy Territory",
        value: breakdown.enemyTerritory ?? 0,
        weight: breakdown.weights?.enemyTerritory ?? 0,
        weightedScore: breakdown.weighted?.enemyTerritoryScore ?? 0,
        averageWeighted: averageWeighted.enemyTerritoryScore ?? 0,
      },
      {
        name: "Enemy Length",
        value: breakdown.enemyLength ?? 0,
        weight: breakdown.weights?.enemyLength ?? 0,
        weightedScore: breakdown.weighted?.enemyLengthScore ?? 0,
        averageWeighted: averageWeighted.enemyLengthScore ?? 0,
      },
      {
        name: "Edge Penalty",
        value: breakdown.edgePenalty ?? breakdown.stats?.edgePenalty ?? 0,
        weight: breakdown.weights?.edgePenalty ?? 50,
        weightedScore: breakdown.weighted?.edgePenaltyScore ?? 0,
        averageWeighted: averageWeighted.edgePenaltyScore ?? 0,
      },
      {
        name: "Self Space",
        value:
          breakdown.selfSpace ?? breakdown.stats?.selfSpace ?? "—",
        weight: breakdown.weights?.selfSpace ?? 120,
        weightedScore: breakdown.weighted?.selfSpaceScore ?? "—",
        averageWeighted: averageWeighted.selfSpaceScore ?? "—",
      },
      {
        name: "Allies Space",
        value:
          breakdown.alliesEnoughSpace ??
          breakdown.stats?.alliesEnoughSpace ??
          0,
        weight: breakdown.weights?.alliesEnoughSpace ?? 15,
        weightedScore: breakdown.weighted?.alliesEnoughSpaceScore ?? 0,
        averageWeighted: averageWeighted.alliesEnoughSpaceScore ?? 0,
      },
      {
        name: "Opponents Space",
        value:
          breakdown.opponentsEnoughSpace ??
          breakdown.stats?.opponentsEnoughSpace ??
          0,
        weight: breakdown.weights?.opponentsEnoughSpace ?? -15,
        weightedScore: breakdown.weighted?.opponentsEnoughSpaceScore ?? 0,
        averageWeighted: averageWeighted.opponentsEnoughSpaceScore ?? 0,
      },
      {
        name: "Kills",
        value: breakdown.kills ?? 0,
        weight: breakdown.weights?.kills ?? 0,
        weightedScore: breakdown.weighted?.killsScore ?? 0,
        averageWeighted: averageWeighted.killsScore ?? 0,
      },
      {
        name: "Deaths",
        value: breakdown.deaths ?? 0,
        weight: breakdown.weights?.deaths ?? 0,
        weightedScore: breakdown.weighted?.deathsScore ?? 0,
        averageWeighted: averageWeighted.deathsScore ?? 0,
      },
      {
        name: "Enemy H2H Risk",
        value: breakdown.enemyH2HRisk ?? 0,
        weight: breakdown.weights?.enemyH2HRisk ?? 0,
        weightedScore: breakdown.weighted?.enemyH2HRiskScore ?? 0,
        averageWeighted: averageWeighted.enemyH2HRiskScore ?? 0,
      },
      {
        name: "Ally H2H Risk",
        value: breakdown.allyH2HRisk ?? 0,
        weight: breakdown.weights?.allyH2HRisk ?? 0,
        weightedScore: breakdown.weighted?.allyH2HRiskScore ?? 0,
        averageWeighted: averageWeighted.allyH2HRiskScore ?? 0,
      },
      {
        name: "Waypoint Goto (green)",
        value: breakdown.waypointGoto ?? 0,
        weight: breakdown.weights?.waypointGoto ?? 0,
        weightedScore: breakdown.weighted?.waypointGotoScore ?? 0,
        averageWeighted: averageWeighted.waypointGotoScore ?? 0,
      },
      {
        name: "Waypoint Near (blue)",
        value: breakdown.waypointNear ?? 0,
        weight: breakdown.weights?.waypointNear ?? 0,
        weightedScore: breakdown.weighted?.waypointNearScore ?? 0,
        averageWeighted: averageWeighted.waypointNearScore ?? 0,
      },
      {
        name: "Aggression (hunt weaker)",
        value: breakdown.aggression ?? "—",
        weight: breakdown.weights?.aggression ?? 0,
        weightedScore: breakdown.weighted?.aggressionScore ?? 0,
        averageWeighted: averageWeighted.aggressionScore ?? 0,
      },
      {
        name: "Trapped (fatal pocket)",
        value: breakdown.trapped ?? "—",
        weight: breakdown.weights?.trapped ?? 0,
        weightedScore: breakdown.weighted?.trappedScore ?? 0,
        averageWeighted: averageWeighted.trappedScore ?? 0,
      },
      ...(breakdown.fertileTerritory !== undefined && !breakdown.myTerritory
        ? [
            {
              name: "Fertile Territory",
              value: breakdown.fertileTerritory ?? 0,
              weight: breakdown.weights?.fertileTerritory ?? 1,
              weightedScore: breakdown.weighted?.fertileScore ?? 0,
              averageWeighted: averageWeighted.fertileScore ?? 0,
            },
          ]
        : []),
    ];

    metricsConfig.forEach((metric) => {
      metric.marginalImpact = metric.weightedScore - metric.averageWeighted;
    });

    metricsConfig.sort(
      (a, b) => Math.abs(b.marginalImpact) - Math.abs(a.marginalImpact),
    );

    let rows = metricsConfig.map((metric) => {
      const weightDisplay = metric.weight !== 0 ? metric.weight : "";
      const scoreDisplay =
        metric.weight !== 0 ? metric.weightedScore.toFixed(2) : "";
      const impactDisplay =
        metric.weight !== 0
          ? (metric.marginalImpact >= 0 ? "+" : "") +
            metric.marginalImpact.toFixed(2)
          : "";
      let impactColor = "#888";
      if (metric.marginalImpact > 0) impactColor = "#4CAF50";
      else if (metric.marginalImpact < 0) impactColor = "#f44336";
      return `
        <tr>
          <td>${metric.name}</td>
          <td>${formatValue(metric.value)}</td>
          <td>${weightDisplay}</td>
          <td>${scoreDisplay}</td>
          <td style="color: ${impactColor}; font-weight: 600;">${impactDisplay}</td>
        </tr>
      `;
    });

    const totalMarginalImpact =
      move.score -
      candidateMoves.reduce((sum, m) => sum + (m.score ?? 0), 0) /
        candidateMoves.length;
    rows.push(`
      <tr class="total-row">
        <td>Total Score</td>
        <td colspan="2">States: ${move.numStates || 1}</td>
        <td>${(move.score ?? 0).toFixed(2)}</td>
        <td style="color: ${totalMarginalImpact >= 0 ? "#4CAF50" : "#f44336"}; font-weight: 600;">
          ${totalMarginalImpact >= 0 ? "+" : ""}${totalMarginalImpact.toFixed(2)}
        </td>
      </tr>
    `);

    tbody.innerHTML = rows.join("");
  }

  function renderMinimap(canvas, gameState, ourSnakeId) {
    const ctx = canvas.getContext("2d");
    if (!gameState || !gameState.board) return;
    const board = gameState.board;
    const cellSize = Math.min(
      canvas.width / board.width,
      canvas.height / board.height,
    );
    const boardW = board.width * cellSize;
    const boardH = board.height * cellSize;

    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    for (let x = 0; x <= board.width; x++) {
      const px = Math.floor(x * cellSize) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, boardH);
      ctx.stroke();
    }
    for (let y = 0; y <= board.height; y++) {
      const py = Math.floor(y * cellSize) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(boardW, py);
      ctx.stroke();
    }

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, boardW - 2, boardH - 2);

    if (board.hazards && board.hazards.length > 0) {
      board.hazards.forEach((hazard) => {
        const x = hazard.x * cellSize;
        const y = (board.height - 1 - hazard.y) * cellSize;
        ctx.save();
        ctx.fillStyle = "#dc1e1e";
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.restore();
      });
    }

    if (board.fertileTiles && board.fertileTiles.length > 0) {
      board.fertileTiles.forEach((tile) => {
        const x = tile.x * cellSize;
        const y = (board.height - 1 - tile.y) * cellSize;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cellSize, cellSize);
        ctx.clip();
        ctx.strokeStyle = "rgba(240, 198, 70, 0.85)";
        ctx.lineWidth = Math.max(1.5, cellSize / 7);
        const stripeSpacing = Math.max(4, cellSize / 3.5);
        for (let offset = 0; offset <= cellSize * 2; offset += stripeSpacing) {
          ctx.beginPath();
          ctx.moveTo(x + offset, y);
          ctx.lineTo(x + offset - cellSize, y + cellSize);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    board.food.forEach((food) => {
      const x = food.x * cellSize;
      const y = (board.height - 1 - food.y) * cellSize;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cellSize, cellSize);
      ctx.clip();
      const emojiSize = Math.max(cellSize * 0.7, 6);
      ctx.font = `${emojiSize}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u{1F383}", x + cellSize / 2, y + cellSize / 2);
      ctx.restore();
    });

    if (
      board.invulnerabilityPotions &&
      board.invulnerabilityPotions.length > 0
    ) {
      board.invulnerabilityPotions.forEach((potion) => {
        const x = potion.x * cellSize;
        const y = (board.height - 1 - potion.y) * cellSize;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cellSize, cellSize);
        ctx.clip();
        if (_potionImage) {
          ctx.drawImage(_potionImage, x, y, cellSize, cellSize);
        } else {
          const emojiSize = Math.max(cellSize * 0.7, 6);
          ctx.font = `${emojiSize}px serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("\u{1F9EA}", x + cellSize / 2, y + cellSize / 2);
        }
        ctx.restore();
      });
    }

    const controlledIds = Array.isArray(ourSnakeId)
      ? new Set(ourSnakeId)
      : new Set(ourSnakeId ? [ourSnakeId] : []);

    board.snakes.forEach((snake) => {
      renderSnakeUnified(ctx, snake, board.height, cellSize, {
        isControlled: controlledIds.has(snake.id),
      });
    });
  }

  return {
    hexToRgba,
    getMoveQuality,
    getScoreColor,
    processMoveEvaluations,
    renderBoard,
    createBoardOverlay,
    renderSnakeInfo,
    renderMoveButtons,
    updateStatsTable,
    renderMinimap,
    renderTerritoryBoundaries,
    renderSnakeUnified,
    getTeamKey,
    getDisappearedSnakes,
    drawDeathMarker,
    drawUnknownDeathMarker,
    getClickedCell,
    findSnakeAtCell,
    findTerritoryOwnerAtCell,
    _moveClickHandler: null,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = BoardRenderer;
}
