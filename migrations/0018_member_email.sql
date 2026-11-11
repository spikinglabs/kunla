-- People can sign in with their work Google or Microsoft account (KD-68). The account's verified email is matched
-- to this column, which an admin (or the person) sets. Agents keep using tokens.
ALTER TABLE members ADD COLUMN email TEXT;
CREATE INDEX IF NOT EXISTS members_email ON members(email);
