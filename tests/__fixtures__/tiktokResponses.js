// TikTok Content Posting API v2 sample responses.
// FLAG-FOR-REVIEW: `data.publish_id` format and `data.status` enum values
// are based on public docs but should be verified against a real account.
export const tiktokTokenResponse = {
  access_token: 'tt-access-token-abc',
  expires_in: 86400,
  refresh_token: 'tt-refresh-token-xyz',
  refresh_expires_in: 8640000,
  scope: 'video.publish,video.upload,user.info.basic',
  token_type: 'Bearer',
  open_id: 'open-id-deadbeef',
};

export const tiktokInitResponse = {
  data: {
    publish_id: 'v_pub_url~v2.0123456789abcdef',
    upload_url: 'https://open-upload.tiktokapis.com/upload/?upload_id=abc&upload_token=def',
  },
  error: { code: 'ok', message: '', log_id: 'log-1' },
};

export const tiktokStatusPublished = {
  data: {
    status: 'PUBLISH_COMPLETE',
    publicaly_available_post_id: ['v_post_url~xyz'],
    uploaded_bytes: 12345,
  },
  error: { code: 'ok', message: '', log_id: 'log-2' },
};

export const tiktokStatusProcessing = {
  data: {
    status: 'PROCESSING_UPLOAD',
    uploaded_bytes: 6000,
  },
  error: { code: 'ok', message: '', log_id: 'log-3' },
};

export const sampleHighlight = {
  vodId: '987654321',
  startSec: 1200,
  endSec: 1245,
  score: 0.87,
  reason: 'audio_spike+chat_velocity',
};

export const sampleClip = {
  id: 'clip-uuid-0001',
  filePath: '/tmp/clips/clip-uuid-0001.mp4',
  sourceVodId: '987654321',
  durationSec: 45,
  createdAt: '2026-05-24T19:00:00.000Z',
};
