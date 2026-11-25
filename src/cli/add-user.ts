import { loadConfig } from '../platform/config.js';
import { openDb } from '../platform/db.js';
import { createUser } from '../platform/auth.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--admin');
const isAdmin = process.argv.includes('--admin');
const [email, name, password] = args;
if (!email || !name) {
  console.error('usage: node dist/cli/add-user.js <email> <name> [password] [--admin]');
  process.exit(1);
}

const config = loadConfig();
const db = openDb(config.dbPath);
try {
  const generated = password || undefined;
  const { user, code } = createUser(db, name, generated, { email, isAdmin });
  console.log(`user: ${user.name} (${user.id})`);
  console.log(`email: ${email}`);
  if (!password) console.log(`password: ${code}`);
  console.log(`admin: ${isAdmin ? 'yes' : 'no'}`);
  console.log('Give the password to the user once. It is stored hashed.');
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
