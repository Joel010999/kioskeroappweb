/** The only canonical signed-quantity rule used by dashboard analytics. */
export function signedQuantity(tipomov: string, cantidad: number): number {
  switch (tipomov.trim()) {
    case "VT":
      return cantidad;
    case "IN":
      return -cantidad;
    default:
      return 0;
  }
}

export const signedQuantitySql = `
  CASE
    WHEN TRIM(m.tipomov) = 'VT' THEN m.cantidad
    WHEN TRIM(m.tipomov) = 'IN' THEN -m.cantidad
    ELSE 0
  END
`;
