import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export type Campaign = {
  status: "draft" | "running" | "paused" | "stopped";
  max_concurrent: number;
  max_attempts: number;
  window_start: string;
  window_end: string;
};

export async function getCampaign(): Promise<Campaign> {
  const c = await one<Campaign>(
    `select status, max_concurrent, max_attempts,
            to_char(window_start,'HH24:MI') as window_start,
            to_char(window_end,'HH24:MI')   as window_end
       from campaign where id = 1`,
  );
  if (!c) throw new Error("Campagne-rij ontbreekt. Draai db/schema.sql.");
  return c;
}

export async function logEvent(kind: string, detail: unknown, partnerId?: string) {
  await q(`insert into events (partner_id, kind, detail) values ($1,$2,$3)`, [
    partnerId ?? null,
    kind,
    JSON.stringify(detail ?? {}),
  ]);
}
