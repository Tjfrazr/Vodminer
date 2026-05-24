/**
 * @typedef {Object} Highlight
 * @property {string} vodId
 * @property {number} startSec
 * @property {number} endSec
 * @property {number} score
 * @property {string} reason
 */

/**
 * @typedef {Object} Clip
 * @property {string} id
 * @property {string} filePath
 * @property {string} sourceVodId
 * @property {number} durationSec
 * @property {string} createdAt
 */

/**
 * @typedef {Object} ReviewItem
 * @property {string} clipId
 * @property {string} previewUrl
 * @property {'pending'|'approved'|'rejected'} status
 */

/**
 * @typedef {Object} PostJob
 * @property {string} clipId
 * @property {string} scheduledFor
 * @property {string} caption
 * @property {string[]} hashtags
 */

export {};
