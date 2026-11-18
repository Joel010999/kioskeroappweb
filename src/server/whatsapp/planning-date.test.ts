import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNextPlanningSaturday,
  PLANNING_TIMEZONE,
} from "@/server/analytics/weekly-replenishment-rules";

vi.mock("@/server/db/client", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  withTransaction: vi.fn(),
}));

vi.mock("@/server/auth/sources", () => ({
  getSourceForBranch: vi.fn().mockResolvedValue("mock_source"),
}));

vi.mock("@/server/analytics/weekly-replenishment", () => ({
  DEPOT_BRANCH_ID: 1,
  getWeeklyReplenishment: vi.fn(),
}));

import { getWeeklyReplenishment } from "@/server/analytics/weekly-replenishment";
import { queryReplenishment, queryReplenishmentExcelData } from "./queries";

describe("Fecha dinámica de planificación semanal (getNextPlanningSaturday + Bot WhatsApp)", () => {
  beforeEach(() => {
    vi.mocked(getWeeklyReplenishment).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("1. Regla de cálculo por día de la semana (America/Argentina/Buenos_Aires)", () => {
    it("Lunes -> devuelve el sábado de esa misma semana (+5 días)", () => {
      // Lunes 16/11/2026 12:00 ART (15:00 UTC)
      const monday = new Date("2026-11-16T15:00:00.000Z");
      expect(getNextPlanningSaturday(monday)).toBe("2026-11-21");
    });

    it("Viernes -> devuelve el sábado siguiente (+1 día)", () => {
      // Viernes 20/11/2026 12:00 ART (15:00 UTC)
      const friday = new Date("2026-11-20T15:00:00.000Z");
      expect(getNextPlanningSaturday(friday)).toBe("2026-11-21");
    });

    it("Sábado -> utiliza ese mismo sábado (+0 días, coherente con la Web)", () => {
      // Sábado 21/11/2026 10:00 ART (13:00 UTC)
      const saturday = new Date("2026-11-21T13:00:00.000Z");
      expect(getNextPlanningSaturday(saturday)).toBe("2026-11-21");
    });

    it("Domingo -> salta al próximo sábado (+6 días)", () => {
      // Domingo 22/11/2026 10:00 ART (13:00 UTC)
      const sunday = new Date("2026-11-22T13:00:00.000Z");
      expect(getNextPlanningSaturday(sunday)).toBe("2026-11-28");
    });
  });

  describe("2. Cambios de mes, año y año bisiesto", () => {
    it("Cambio de mes: Domingo 29/11/2026 -> Sábado 05/12/2026", () => {
      const endOfMonthSunday = new Date("2026-11-29T15:00:00.000Z");
      expect(getNextPlanningSaturday(endOfMonthSunday)).toBe("2026-12-05");
    });

    it("Cambio de mes: Miércoles 30/09/2026 -> Sábado 03/10/2026", () => {
      const endOfSep = new Date("2026-09-30T15:00:00.000Z");
      expect(getNextPlanningSaturday(endOfSep)).toBe("2026-10-03");
    });

    it("Cambio de año: Lunes 28/12/2026 -> Sábado 02/01/2027", () => {
      const lateDec = new Date("2026-12-28T15:00:00.000Z");
      expect(getNextPlanningSaturday(lateDec)).toBe("2027-01-02");
    });

    it("Cambio de año con frontera UTC: Jueves 31/12/2026 23:00 ART (ya 01/01/2027 02:00 UTC) -> Sábado 02/01/2027", () => {
      const newYearsEveArt = new Date("2027-01-01T02:00:00.000Z");
      expect(getNextPlanningSaturday(newYearsEveArt)).toBe("2027-01-02");
    });

    it("Año bisiesto: Domingo 27/02/2028 -> Sábado 04/03/2028 (cruza 29/02)", () => {
      const leapSunday = new Date("2028-02-27T15:00:00.000Z");
      expect(getNextPlanningSaturday(leapSunday)).toBe("2028-03-04");
    });
  });

  describe("3. Fronteras de zona horaria Argentina (UTC-3 vs UTC)", () => {
    it("Sábado 21/11/2026 22:30 ART (Domingo 22/11 01:30 UTC) sigue siendo sábado 2026-11-21 en Argentina", () => {
      const saturdayLateNightArt = new Date("2026-11-22T01:30:00.000Z");
      expect(PLANNING_TIMEZONE).toBe("America/Argentina/Buenos_Aires");
      // En UTC sería domingo (+6 -> 2026-11-28), pero en Argentina sigue siendo sábado 21/11!
      expect(getNextPlanningSaturday(saturdayLateNightArt)).toBe("2026-11-21");
    });

    it("Viernes 20/11/2026 22:30 ART (Sábado 21/11 01:30 UTC) devuelve sábado 2026-11-21", () => {
      const fridayLateNightArt = new Date("2026-11-21T01:30:00.000Z");
      expect(getNextPlanningSaturday(fridayLateNightArt)).toBe("2026-11-21");
    });

    it("Domingo 22/11/2026 00:30 ART (Domingo 22/11 03:30 UTC) avanza al sábado 2026-11-28", () => {
      const sundayJustAfterMidnightArt = new Date("2026-11-22T03:30:00.000Z");
      expect(getNextPlanningSaturday(sundayJustAfterMidnightArt)).toBe("2026-11-28");
    });
  });

  describe("4. Coherencia entre consulta de texto, Excel del Bot y Web (sin fechas fijas)", () => {
    it("queryReplenishment y queryReplenishmentExcelData usan exactamente la misma fecha dinámica de Argentina y nunca '2026-10-24'", async () => {
      const testInstants: Array<{ label: string; isoUtc: string; expectedSaturday: string }> = [
        { label: "Miércoles 18/11/2026 ART", isoUtc: "2026-11-18T14:00:00.000Z", expectedSaturday: "2026-11-21" },
        { label: "Sábado 21/11/2026 22:30 ART (Domingo UTC)", isoUtc: "2026-11-22T01:30:00.000Z", expectedSaturday: "2026-11-21" },
        { label: "Domingo 29/11/2026 ART (cambio de mes)", isoUtc: "2026-11-29T15:00:00.000Z", expectedSaturday: "2026-12-05" },
        { label: "Lunes 28/12/2026 ART (cambio de año)", isoUtc: "2026-12-28T15:00:00.000Z", expectedSaturday: "2027-01-02" },
      ];

      for (const tc of testInstants) {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(tc.isoUtc));
        vi.mocked(getWeeklyReplenishment).mockReset();
        vi.mocked(getWeeklyReplenishment).mockResolvedValue({
          planning_date: tc.expectedSaturday,
          location: { branch_id: 2, label: "Centro" },
          window_weeks: 6,
          coverage_days: 10,
          total: 0,
          rubros: [],
          suppliers: [],
          items: [],
        });

        const textRes = await queryReplenishment(2, undefined, "50922");
        const excelRes = await queryReplenishmentExcelData({
          branchId: 2,
          supplierCode: "50922",
        });

        const webDefault = getNextPlanningSaturday();

        expect(textRes.planningDate, `${tc.label} textRes`).toBe(tc.expectedSaturday);
        expect(excelRes.planningDate, `${tc.label} excelRes`).toBe(tc.expectedSaturday);
        expect(webDefault, `${tc.label} webDefault`).toBe(tc.expectedSaturday);
        expect(textRes.planningDate).toBe(excelRes.planningDate);
        expect(textRes.planningDate).not.toBe("2026-10-24");

        // Verificar que ambas llamadas pasaron la fecha dinámica a getWeeklyReplenishment
        expect(vi.mocked(getWeeklyReplenishment)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(getWeeklyReplenishment).mock.calls[0][0].planningDate).toBe(tc.expectedSaturday);
        expect(vi.mocked(getWeeklyReplenishment).mock.calls[1][0].planningDate).toBe(tc.expectedSaturday);
      }
    });
  });
});
