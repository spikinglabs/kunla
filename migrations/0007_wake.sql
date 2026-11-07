-- Wake-up URL for an AI member: Kunla calls it when a person approves, sends back, answers or assigns
-- that agent's work, so the agent carries on by itself. JSON: {url, format, secret, auth}.
ALTER TABLE members ADD COLUMN callback TEXT;
