-- Schema as it existed before migrations were introduced.
-- IF NOT EXISTS makes this a no-op on existing databases and a bootstrap on new ones.

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  name varchar,
  email varchar,
  password text,
  display_picture_url text,
  verified boolean,
  uuid text,
  provider text,
  recent text[],
  purchased_songs text[],
  favorites text[],
  minted_tracks text[]
);

CREATE TABLE IF NOT EXISTS otplinks (
  id serial PRIMARY KEY,
  user_id integer REFERENCES users(id),
  otp_number integer,
  created_at timestamp,
  expires_at timestamp
);

CREATE TABLE IF NOT EXISTS playlist (
  id serial PRIMARY KEY,
  playlist_type varchar,
  cover text,
  title varchar,
  genre varchar,
  artiste_id integer REFERENCES users(id),
  record_label text
);

CREATE TABLE IF NOT EXISTS music (
  id serial PRIMARY KEY,
  title text,
  featured_artistes text,
  writers text,
  producers text,
  explicit boolean,
  song_duration text,
  price text,
  token_id text,
  artiste_id integer REFERENCES users(id),
  album_id integer REFERENCES playlist(id),
  release_day text,
  release_year text
);
