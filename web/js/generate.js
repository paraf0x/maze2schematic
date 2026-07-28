// Maze generator, ported from jsmaze (Dungeon Maze Generator).
//
// Original: Morgan McGuire, @CasualEffects, https://casual-effects.com
// https://morgan3d.github.io/misc/jsmaze/ (BSD license)
//
// The generator works on a block grid: EMPTY (0) = corridor,
// SOLID (255) = wall. Cells sit at odd indices, walls in between.
// The hall/wall size from the original is dropped here -- the geometry
// comes from the Litematica tiles. The result is converted into the
// cell-mask model (`Maze`) and runs through the normal tile pipeline.
//
// Back-port of maze2schematic/generate.py (which was itself ported from
// jsmaze/JS to Python). Function structure, variable names, and comments
// are deliberately kept in sync so this code stays diffable against
// generate.py.

// Directions, clockwise (important for the rotation logic)
export const N = 0, E = 1, S = 2, W = 3;

export const SOLID = 255, RESERVED = 127, EMPTY = 0;

// Presets from the jsmaze website (hall/wall size is dropped):
// {hloop, vloop, hborder, vborder, hmirror, vmirror, shortcuts, straightness, coverage, rooms}
export const DUNGEON_PRESETS = {
  labyrinth: { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: false, vmirror: false, shortcuts: 0.00, straightness: 0.00, coverage: 1.00, rooms: 0.00 },
  catacombs: { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: false, vmirror: false, shortcuts: 0.00, straightness: 0.00, coverage: 0.20, rooms: 1.00 },
  hedge:     { hloop: false, vloop: false, hborder: 0, vborder: 0, hmirror: false, vmirror: false, shortcuts: 0.00, straightness: 0.00, coverage: 1.00, rooms: 0.15 },
  palace:    { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: false, vmirror: false, shortcuts: 0.25, straightness: 0.00, coverage: 0.10, rooms: 0.50 },
  fortress:  { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: false, vmirror: false, shortcuts: 0.75, straightness: 0.50, coverage: 0.15, rooms: 1.00 },
  suburb:    { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: false, vmirror: false, shortcuts: 0.05, straightness: 0.90, coverage: 0.20, rooms: 1.00 },
  city:      { hloop: true,  vloop: true,  hborder: 1, vborder: 1, hmirror: false, vmirror: false, shortcuts: 0.60, straightness: 0.00, coverage: 1.00, rooms: 1.00 },
  pacman:    { hloop: true,  vloop: false, hborder: 1, vborder: 1, hmirror: true,  vmirror: false, shortcuts: 0.25, straightness: 0.80, coverage: 1.00, rooms: 0.00 },
  starship:  { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: true,  vmirror: false, shortcuts: 0.90, straightness: 0.10, coverage: 0.12, rooms: 1.00 },
  garden:    { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: true,  vmirror: true,  shortcuts: 1.00, straightness: 0.95, coverage: 0.50, rooms: 1.00 },
  forbidden: { hloop: false, vloop: false, hborder: 1, vborder: 1, hmirror: true,  vmirror: false, shortcuts: 0.20, straightness: 1.00, coverage: 0.50, rooms: 0.10 },
};

export function defaultOptions() {
  return {
    cols: 20,
    rows: 20,
    straightness: 0,
    shortcuts: 0,
    coverage: 1,
    rooms: 0,
    horizontal: { loop: false, mirror: false, border: 1 },
    vertical: { loop: false, mirror: false, border: 1 },
    entrances: true,
  };
}

export function presetOptions(name, cols, rows) {
  const { hloop, vloop, hborder, vborder, hmirror, vmirror, shortcuts, straightness, coverage, rooms } = DUNGEON_PRESETS[name];
  return {
    cols,
    rows,
    straightness,
    shortcuts,
    coverage,
    rooms,
    horizontal: { loop: hloop, mirror: hmirror, border: hborder },
    vertical: { loop: vloop, mirror: vmirror, border: vborder },
    entrances: true,
  };
}

// Direct port of makeMaze() from jsmaze (hall/wall = 1).
function _makeMaze(w, h, horizontal, vertical, straightness, imperfect, fill, deadEnds, rng) {
  const hSymmetry = horizontal.mirror;
  const hBorder = horizontal.border;
  // Ignore wrapping unless border and symmetry are both set; in that case
  // generate without wrapping and punch holes into the border
  const hWrap = horizontal.loop && !(hSymmetry && hBorder);

  const vSymmetry = vertical.mirror;
  const vBorder = vertical.border;
  const vWrap = vertical.loop && !(vSymmetry && vBorder);

  function randomInt(x) {
    return Math.floor(rng.random() * x);
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
  }

  // Pre-compensate for borders that will be removed later
  if (!hBorder) {
    w += 1;
    if (!hWrap) {
      w += 1;
    }
  }
  if (!vBorder) {
    h += 1;
    if (!vWrap) {
      h += 1;
    }
  }

  imperfect = Math.min(1.0, Math.max(0.0, imperfect));
  const reserveProb = (1 - Math.min(Math.max(0.0, fill * 0.9 + 0.1), 1.0)) ** 1.6;

  if (hWrap) {
    if (hSymmetry) {
      w = Math.round((w - 2) / 4) * 4 + 2;
    } else {
      w += w & 1;
    }
  } else {
    w += ~(w & 1);
  }

  if (vWrap) {
    if (vSymmetry) {
      h = Math.round((h - 2) / 4) * 4 + 2;
    } else {
      h += h & 1;
    }
  } else {
    h += ~(h & 1);
  }

  // maze is indexed column-wise: maze[x][y]
  const maze = Array.from({ length: w }, () => new Array(h).fill(SOLID));

  if (reserveProb > 0) {
    for (let x = 1; x < w; x += 2) {
      for (let y = 1; y < h; y += 2) {
        if (rng.random() < reserveProb) {
          maze[x][y] = RESERVED;
        }
      }
    }
  }

  // Carve corridors (DFS), starting in the middle
  const startStep = [0, 0];
  // Directions as constant array references: step is always one of these
  // references (or startStep); shuffle only swaps references within the array.
  const directions = [[-1, 0], [1, 0], [0, 1], [0, -1]];
  const stack = [[Math.floor(w / 4) * 2 - 1, Math.floor(h / 4) * 2 - 1, startStep]];
  deadEnds.push([stack[0][0], stack[0][1]]);

  // Only consider reserved cells once a minimum path exists
  let ignoreReserved = Math.max(w, h);

  function unexplored(x, y) {
    const c = maze[x][y];
    return c === SOLID || (c === RESERVED && ignoreReserved > 0);
  }

  const hBorderOffset = hWrap ? 0 : 1;
  const vBorderOffset = vWrap ? 0 : 1;

  function setCell(x, y, value) {
    x = ((x % w) + w) % w;
    y = ((y % h) + h) % h;
    maze[x][y] = value;
    const u = w - x - hBorderOffset;
    const v = h - y - vBorderOffset;
    if (hSymmetry && u < w) {
      maze[u][y] = value;
      if (vSymmetry && v < h) {
        maze[u][v] = value;
      }
    }
    if (vSymmetry && v < h) {
      maze[x][v] = value;
    }
  }

  while (stack.length) {
    const [cx, cy, step] = stack.pop();
    if (!unexplored(cx, cy)) {
      continue;
    }
    setCell(cx, cy, EMPTY);
    // Also open the wall toward the origin
    setCell(cx - step[0], cy - step[1], EMPTY);
    ignoreReserved -= 1;

    shuffle(directions);

    // Prefer straight ahead: sort the last step to the end
    // (the stack is LIFO, the last element is processed first)
    if (rng.random() < straightness) {
      for (let i = 0; i < 4; i++) {
        if (directions[i] === step) {
          directions[i] = directions[3];
          directions[3] = step;
          break;
        }
      }
    }

    let deadEnd = true;
    for (const stepDir of [...directions]) {
      let x = cx + stepDir[0] * 2;
      let y = cy + stepDir[1] * 2;
      if (hWrap) {
        x = ((x % w) + w) % w;
      }
      if (vWrap) {
        y = ((y % h) + h) % h;
      }
      if (x >= 0 && x < w && y >= 0 && y < h && unexplored(x, y)) {
        stack.push([x, y, stepDir]);
        deadEnd = false;
      }
    }

    if (deadEnd) {
      deadEnds.push([cx, cy]);
    }
  }

  if (imperfect > 0) {
    const hBdry = hWrap ? 0 : 1;
    const vBdry = vWrap ? 0 : 1;

    function remove(x, y) {
      const a = maze[x][(y + 1) % h];
      const b = maze[x][(y - 1 + h) % h];
      const c = maze[(x + 1) % w][y];
      const d = maze[(x - 1 + w) % w][y];
      if (Math.min(a, b, c, d) === EMPTY) {
        setCell(x, y, EMPTY);
      }
    }

    for (let i = 0; i < Math.ceil((imperfect * w * h) / 3); i++) {
      remove(
        randomInt(w * 0.5 - hBdry * 2) * 2 + 1,
        randomInt(h * 0.5 - vBdry * 2) * 2 + vBdry * 2,
      );
      remove(
        randomInt(w * 0.5 - hBdry * 2) * 2 + hBdry * 2,
        randomInt(h * 0.5 - vBdry * 2) * 2 + 1,
      );
    }

    // Reconnect isolated wall islands
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const a = maze[x][(y + 1) % h];
        const b = maze[x][(y - 1 + h) % h];
        const c = maze[(x + 1) % w][y];
        const d = maze[(x - 1 + w) % w][y];
        if (a === EMPTY && b === EMPTY && c === EMPTY && d === EMPTY) {
          const [dx, dy] = directions[randomInt(4)];
          setCell(x + dx, y + dy, SOLID);
        }
      }
    }
  }

  // Clear reservations
  if (reserveProb > 0) {
    for (let x = 1; x < w; x += 2) {
      for (let y = 1; y < h; y += 2) {
        if (maze[x][y] === RESERVED) {
          maze[x][y] = SOLID;
        }
      }
    }
  }

  if (horizontal.loop && hBorder && hSymmetry) {
    const prob = 0.025 + 0.25 * (1 - straightness ** 2 * (1 - imperfect)) + 0.5 * imperfect;
    for (let y = 1; y < maze[0].length; y += 2) {
      if (maze[1][y] === EMPTY && (y < 2 || maze[0][y - 2] !== EMPTY) && rng.random() < prob) {
        maze[0][y] = EMPTY;
        maze[w - 1][y] = EMPTY;
      }
    }
  }

  if (vertical.loop && vBorder && vSymmetry) {
    const prob = 0.05 + 0.15 * (1 - straightness * (1 - imperfect)) + 0.5 * imperfect;
    for (let x = 1; x < maze.length; x += 2) {
      if (maze[x][1] === EMPTY && (x < 2 || maze[x - 2][0] !== EMPTY) && rng.random() < prob) {
        maze[x][0] = EMPTY;
        maze[x][h - 1] = EMPTY;
      }
    }
  }

  // Horizontal borders
  if (!hWrap && !hBorder) {
    maze.shift();
    maze.pop();
    for (const de of deadEnds) {
      de[0] -= 1;
    }
  } else if (hBorder && hWrap && !hSymmetry) {
    // Duplicate the left edge on the right
    maze.push([...maze[0]]);
    for (const de of [...deadEnds]) {
      if (de[0] === 0) {
        deadEnds.push([maze.length - 1, de[1]]);
      }
    }
  } else if (hSymmetry && hWrap) {
    maze.shift();
    maze.shift();
    for (const de of deadEnds) {
      de[0] -= 2;
    }
  }

  // Vertical borders
  if (vBorder && vWrap && !vSymmetry) {
    for (const col of maze) {
      col.push(col[0]);
    }
    for (const de of [...deadEnds]) {
      if (de[1] === 0) {
        deadEnds.push([de[0], maze[0].length - 1]);
      }
    }
  } else if (!vWrap && !vBorder) {
    for (const col of maze) {
      col.shift();
      col.pop();
    }
    for (const de of deadEnds) {
      de[1] -= 1;
    }
  } else if (vSymmetry && vWrap) {
    for (const col of maze) {
      col.shift();
      col.shift();
    }
    for (const de of deadEnds) {
      de[1] -= 2;
    }
  }

  // Remove dead ends outside the grid
  const filtered = deadEnds.filter((de) => de[0] >= 0 && de[1] >= 0);
  deadEnds.length = 0;
  deadEnds.push(...filtered);

  return maze;
}

// Port of addMapRooms() from jsmaze (hall/wall = 1).
function _addRooms(lattice, horizontal, vertical, deadEnds, roomsFraction) {
  const w = lattice.length, h = lattice[0].length;
  roomsFraction = Math.max(0.0, Math.min(1.0, roomsFraction));

  // Room size (depends on hall+wall = 2 in the original)
  const a = Math.ceil((0.6 * 2) / Math.max(roomsFraction, 0.4));
  const b = a;

  const last = Math.floor((deadEnds.length - 1) * roomsFraction);
  for (let i = last; i >= 0; i--) {
    const [cx, cy] = deadEnds[i];
    const u = Math.floor(cx - a / 2);
    const v = Math.floor(cy - b / 2);
    for (let x = Math.max(1, u - a); x <= Math.min(w - 2, u + a); x++) {
      const lo = Math.max(1, v - b), hi = Math.min(h - 1, v + b + 1);
      for (let y = lo; y < hi; y++) {
        lattice[x][y] = EMPTY;
      }
    }
  }

  // Restore symmetry
  if (horizontal.mirror) {
    const offset = horizontal.loop ? 2 : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < Math.floor(w / 2) + 1; x++) {
        lattice[w - offset - x][y] = lattice[x][y];
      }
    }
  }
  if (vertical.mirror) {
    const offset = vertical.loop ? 2 : 1;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < Math.floor(h / 2) + 1; y++) {
        lattice[x][h - offset - y] = lattice[x][y];
      }
    }
  }
}

// Converts the block grid into cell masks.
//
// Cells sit at index `1 - phase + 2k`. Cells that weren't carved (SOLID)
// get an empty mask (-> closed tile). Room carve-outs on wall posts
// (even/even) can't be represented by tiles; the tiles' posts then remain
// standing as pillars.
function _latticeToMaze(lattice, xPhase, yPhase) {
  const lw = lattice.length, lh = lattice[0].length;
  const xs = [];
  for (let x = 1 - xPhase; x < lw; x += 2) xs.push(x);
  const ys = [];
  for (let y = 1 - yPhase; y < lh; y += 2) ys.push(y);
  const rows = ys.length, cols = xs.length;

  const masks = Array.from({ length: rows }, () => Array.from({ length: cols }, () => new Set()));
  const dirDeltas = [[N, 0, -1], [E, 1, 0], [S, 0, 1], [W, -1, 0]];
  for (let r = 0; r < ys.length; r++) {
    const ly = ys[r];
    for (let c = 0; c < xs.length; c++) {
      const lx = xs[c];
      if (lattice[lx][ly] !== EMPTY) {
        continue;
      }
      for (const [d, dx, dy] of dirDeltas) {
        const wx = lx + dx, wy = ly + dy;
        if (!(wx >= 0 && wx < lw && wy >= 0 && wy < lh) || lattice[wx][wy] !== EMPTY) {
          continue;
        }
        // Only open an edge if the neighboring cell was also carved.
        // (At coverage < 1 the original can produce wall recesses that
        // the tile model can't represent.) Neighbors outside the grid
        // (loop/border openings) count as open.
        const nx = lx + 2 * dx, ny = ly + 2 * dy;
        if (nx >= 0 && nx < lw && ny >= 0 && ny < lh && lattice[nx][ny] !== EMPTY) {
          continue;
        }
        masks[r][c].add(d);
      }
    }
  }
  return { rows, cols, masks };
}

// Generates a maze with the jsmaze algorithm as a cell-mask maze.
export function generateMaze(opts, rng) {
  // Goal: with border + no wrap, exactly cols x rows cells. makeMaze turns
  // an even w into exactly w-1 (odd) via `w += ~(w & 1)` -> feed in 2*cols+2.
  const deadEnds = [];
  const lattice = _makeMaze(
    2 * opts.cols + 2,
    2 * opts.rows + 2,
    opts.horizontal,
    opts.vertical,
    opts.straightness,
    opts.shortcuts,
    opts.coverage,
    deadEnds,
    rng,
  );

  if (opts.rooms > 0) {
    _addRooms(lattice, opts.horizontal, opts.vertical, deadEnds, opts.rooms);
  }

  const hWrap = opts.horizontal.loop && !(opts.horizontal.mirror && opts.horizontal.border);
  const vWrap = opts.vertical.loop && !(opts.vertical.mirror && opts.vertical.border);
  const xPhase = (!opts.horizontal.border && !hWrap) ? 1 : 0;
  const yPhase = (!opts.vertical.border && !vWrap) ? 1 : 0;
  const maze = _latticeToMaze(lattice, xPhase, yPhase);

  // Punch an entrance/exit into the top/bottom border (only if the border is closed)
  if (opts.entrances && opts.vertical.border && !vWrap) {
    const top = [];
    for (let c = 0; c < maze.cols; c++) if (maze.masks[0][c].size) top.push(c);
    const bottom = [];
    for (let c = 0; c < maze.cols; c++) if (maze.masks[maze.rows - 1][c].size) bottom.push(c);
    if (top.length) {
      maze.masks[0][rng.choice(top)].add(N);
    }
    if (bottom.length) {
      maze.masks[maze.rows - 1][rng.choice(bottom)].add(S);
    }
  }

  return maze;
}
