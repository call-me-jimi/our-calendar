-- Invite links stay copyable while they're valid (spec §3.2): the token itself is kept, besides
-- its hash (which joining still looks up by). NULL for links from before, and once revoked.

ALTER TABLE invites ADD COLUMN token TEXT;
