export function computeVisibleCells(revealedCells, fogRadius, rows, cols) {
  const visible = new Set();

  for (const { row, col } of revealedCells) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dist = Math.sqrt((r - row) ** 2 + (c - col) ** 2);
        if (dist <= fogRadius) {
          visible.add(`${r},${c}`);
        }
      }
    }
  }

  return visible;
}
