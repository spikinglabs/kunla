-- A decision a person made in a chat and their agent recorded (KD-26): who recorded it, the chat
-- link and the person's words, as JSON. NULL for decisions made in Kunla itself.
ALTER TABLE reviews ADD COLUMN via TEXT;
