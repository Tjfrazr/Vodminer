// Helix /videos response shape. Verified against the public Twitch API docs
// for the Get Videos endpoint. Single archive video as the most-recent VOD.
// FLAG-FOR-REVIEW: a few less-common fields (e.g. muted_segments) are omitted —
// vodFetcher only reads id/url/duration/created_at so this should be sufficient.
export const helixVideosResponse = {
  data: [
    {
      id: '987654321',
      stream_id: null,
      user_id: '123456789',
      user_login: 'tjstreams',
      user_name: 'TJStreams',
      title: 'Late night ranked grind',
      description: '',
      created_at: '2026-05-24T01:30:00Z',
      published_at: '2026-05-24T01:30:00Z',
      url: 'https://www.twitch.tv/videos/987654321',
      thumbnail_url: 'https://example.com/thumb.jpg',
      viewable: 'public',
      view_count: 142,
      language: 'en',
      type: 'archive',
      duration: '3h45m12s',
      muted_segments: null,
    },
  ],
  pagination: {},
};

export const helixVideosEmpty = { data: [], pagination: {} };

export const twitchOAuthResponse = {
  access_token: 'twitch-app-token-abc123',
  expires_in: 5011271,
  token_type: 'bearer',
};
