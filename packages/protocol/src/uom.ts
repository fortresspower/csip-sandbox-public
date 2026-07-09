/** UOM codes from IEEE 2030.5-2018 Annex A UomType (IEC 61968-9). */
export const Uom = {
  Amps: 5,
  Voltage: 29,
  Hz: 33,
  W: 38,
  VA: 61,
  var: 63,
  CosTheta: 65,
  Wh: 72,
} as const;

export type UomCode = (typeof Uom)[keyof typeof Uom];
