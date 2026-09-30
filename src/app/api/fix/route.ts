import { query } from '@/server/db/client';
import { NextResponse } from 'next/server';
export const runtime = 'nodejs';
export async function GET() {
  await query('UPDATE order_items SET approved_quantity=requested_quantity, prepared_quantity=requested_quantity WHERE approved_quantity IS NULL');
  return NextResponse.json({ ok: true });
}
