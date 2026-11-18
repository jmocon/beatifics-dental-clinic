// Usage: npm run create-admin -- <email> "<name>" <password>
// Creates an admin account, or resets the password (and reactivates) if the email already exists.
// Day-to-day staff accounts are managed in the portal under Settings → Staff.
import { createUser, setUserPassword } from '../server/auth.ts';
import { defaultDbPath, openDb } from '../server/db.ts';

const [email, name, password] = process.argv.slice(2);

if (!email || !name || !password) {
  console.error('Usage: npm run create-admin -- <email> "<name>" <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const db = openDb(defaultDbPath());
const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim());

if (exists) {
  await setUserPassword(db, email, password);
  console.log(`Password reset for ${email}. Existing sessions were signed out.`);
} else {
  await createUser(db, email, name, password, 'admin');
  console.log(`Admin account created for ${name} <${email}>.`);
}
