/**
 * The QR encoder is the one piece of this feature that fails silently: a
 * wrong module is a label that does not scan, and nothing in the app would
 * notice. So the fixtures below are not hand-rolled — each is the matrix an
 * INDEPENDENT encoder (the `qrcode` npm package, used once during development
 * and never added to this repo) produces for the same input, byte mode, at
 * the mask our encoder selects. `encodeQr` must reproduce them exactly.
 *
 * Between them they cover version 1 through version 9, EC levels L/M/H/Q,
 * a real tag URL, and a multi-byte UTF-8 payload.
 */
import { describe, expect, it } from 'vitest';
import { encodeQr, qrToSvgPath } from '@/features/tags/qr';

const TOKEN = 'a3f9'.repeat(16);
const TAG_URL = `https://familygreenhouse.net/tag/${TOKEN}`;

/** Render a matrix the way the fixtures are written: '#' dark, '.' light. */
function render(matrix: boolean[][]): string {
  return matrix.map((row) => row.map((cell) => (cell ? '#' : '.')).join('')).join('\n');
}

const V1_L =
  '#######..#.##.#######\n#.....#.##.#..#.....#\n#.###.#.##..#.#.###.#\n#.###.#..#.#..#.###.#\n#.###.#.#...#.#.###.#\n#.....#.#..##.#.....#\n#######.#.#.#.#######\n........#####........\n##.#..##.##...###.##.\n.###...#..#..#.##.###\n#.#..##.###.#.##..#.#\n....##.#..##..##.#.##\n####.#####..#..##...#\n........#..#.#...#.##\n#######.#....####.##.\n#.....#..#####.#.....\n#.###.#..###.##....#.\n#.###.#.#.##...######\n#.###.#...#.#...#...#\n#.....#.#.#..####....\n#######.##.##..##..#.';

const URL_M =
  '#######..###.....########...##.#..#######\n#.....#...##....##..##..#..##.#.#.#.....#\n#.###.#.##...##..##..###..#.......#.###.#\n#.###.#.###...#.#..###..##.###....#.###.#\n#.###.#.#.######..##..##.##...###.#.###.#\n#.....#.##..###.....#.#....#.#..#.#.....#\n#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#######\n........##...........#..#.#.#.##.........\n#.#####.....#.#.###...########....#####..\n.#.#.#.#.#.....#..####.#.#..#.###.#.#.###\n.####.#...#.....###.##.....#.#..#####....\n#.##...##.##....#..#.##...###.###...##...\n..#..####.#..#####..#...###..####....####\n.#..#..###.#..###.#...#.....#..#.#####..#\n#.##.####...####..#.##.########..#.##..#.\n#.#.#...##..#####....###...#...##.#.#....\n...#.##.#........##.#.####..##...#.#..##.\n#.#.....##.#...##..#...#..#...###.###...#\n####..####.#....#.#...#..#.##.#.#...###..\n##.##....######....##..##.##......#.##...\n####..##.....#.#..#..##..###.#####.#..#..\n##...#..#.##.#.###.##..##...#..#.##.#..##\n#.###.#...#####..#..##..#####.#.##...#...\n.###....##.##..#..#..#.#..#.......###....\n..###.###..##..###.##.#.####.#.......###.\n.##.....##...#.#..####.#..#.####.#####..#\n.#.##.#.....####.#..#......##.#.##.##..#.\n..#.#....####.###.#.###...##...##....#.##\n###..###..#...#####...#.##..##.#.#...##..\n####.....#.##..#....##..###...###.#######\n#.##.##..###.#...###.#.....#.#..###.###..\n#..##.....#........####.#.#.#.##.#####...\n#..#..#.......##.#.#...#.###.##.#########\n........#..##....########...#..##...##.##\n#######..###.##.##..##...########.#.#.#..\n#.....#.#..#########.##.#..#....#...#..##\n#.###.#.#....#.#....##..##..##..#######.#\n#.###.#.#..#....####..##..#..##.##.#...##\n#.###.#.#......##.#...#..#.##..#.######..\n#.....#..#...#.##.#######..#....#.#.##.#.\n#######.##...####.#.#.#.####.#.#..###.#..';

const UTF8_Q =
  '#######..#####.#.######...#######\n#.....#.##..##....#.#.....#.....#\n#.###.#..#....#.#....#.#..#.###.#\n#.###.#.#...##.#..#.#.###.#.###.#\n#.###.#.#..####..#....##..#.###.#\n#.....#..#..###.####.#..#.#.....#\n#######.#.#.#.#.#.#.#.#.#.#######\n........#.......###....#.........\n.#.####.#.#.##.##.#....####.##.#.\n.#......###..#...#.#.#.#.##...#..\n.....##.##....#.#..##.##.###..#..\n.#.#...###.##..##.#..###....#.#.#\n....###.#..#.##.##.#.#..#.##.#.##\n.###....##..#####.###...##.#...#.\n#.#...#######..#...##.#...##.#...\n###.##..#..######.#.#..###.#.###.\n##.#..###....##..#..#.#.#...###.#\n#.##.#.#.##.#..##.##...#...#..#..\n...##.####..########.####..###...\n##.##......#...######.#.#.#..#.##\n..###.#....###.....#.##....#..##.\n######..#.####..##.....##..####.#\n#..#.##.#.##.#.#.######.##.....##\n#...#...####..#..####.#.#...#.###\n###...#.##..#..###..#..######..##\n........#.###.####...#..#...#.##.\n#######..#.##..#.###...##.#.##.#.\n#.....#.#..##.#...#####.#...#...#\n#.###.#.#.#...##.#...#########.##\n#.###.#.##..#.#...#...#...#..##.#\n#.###.#...#.#.###.##.#.....###.##\n#.....#.#....#.....##.#.####.####\n#######..#########.##..#...#.....';

describe('encodeQr', () => {
  it('reproduces a version-1 L symbol module for module', () => {
    expect(render(encodeQr('plant tag', 'L'))).toBe(V1_L);
  });

  it('reproduces a real tag URL at the default M level', () => {
    const matrix = encodeQr(TAG_URL, 'M');
    expect(matrix).toHaveLength(41); // version 6
    expect(render(matrix)).toBe(URL_M);
  });

  it('reproduces a multi-byte UTF-8 payload at Q', () => {
    expect(render(encodeQr('Café 🌿 Monstera — «Grandma»', 'Q'))).toBe(UTF8_Q);
  });

  it('picks the smallest version that fits and grows with the EC level', () => {
    expect(encodeQr('A', 'L')).toHaveLength(21); // version 1
    // The same URL needs a bigger symbol as more of it is spent on recovery.
    const sizes = (['L', 'M', 'Q', 'H'] as const).map((ec) => encodeQr(TAG_URL, ec).length);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes[0]).toBeLessThan(sizes[3]);
  });

  it('always emits the three finder patterns and the timing rows', () => {
    const m = encodeQr(TAG_URL, 'Q');
    const size = m.length;
    for (const [ox, oy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      expect(m[oy][ox]).toBe(true);
      expect(m[oy + 1][ox + 1]).toBe(false);
      expect(m[oy + 3][ox + 3]).toBe(true); // the 3x3 core
    }
    // Timing pattern: alternating modules along row and column 6.
    for (let i = 8; i < size - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
  });

  it('refuses a payload no version can hold, rather than truncating it', () => {
    expect(() => encodeQr('x'.repeat(3000), 'H')).toThrow(/too long/i);
  });
});

describe('qrToSvgPath', () => {
  it('merges horizontal runs and offsets by the quiet zone', () => {
    const matrix = [
      [true, true, false],
      [false, true, false],
    ];
    expect(qrToSvgPath(matrix, 4)).toBe('M4 4h2v1h-2zM5 5h1v1h-1z');
  });

  it('draws nothing for an all-light matrix', () => {
    expect(qrToSvgPath([[false, false]], 0)).toBe('');
  });
});
