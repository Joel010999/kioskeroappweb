import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(scryptCallback);
const { Client } = pg;
const email = process.argv[2]?.trim().toLowerCase();
if (!email) throw new Error("Usage: node scripts/provision-user.mjs <email>");

const prompt = createInterface({ input, output });
const password = await prompt.question("Password: ", { hideEchoBack: true });
prompt.close();
if (!password) throw new Error("Password is required.");

const salt = randomBytes(16).toString("base64url");
const hash = (await scrypt(password, salt, 64)).toString("base64url");
const passwordHash = `scrypt$${salt}$${hash}`;
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE users SET organization_id=1, password_hash=$2, active=true, updated_at=now() WHERE email=$1", [email, passwordHash]);
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally { await client.end(); }
console.log("User credentials provisioned.");
