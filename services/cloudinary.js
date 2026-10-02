const cloudinary = require('cloudinary').v2;

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const API_KEY = process.env.CLOUDINARY_API_KEY || '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

const isCloudinaryConfigured = Boolean(CLOUD_NAME && API_KEY && API_SECRET);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
    secure: true
  });
  console.log(`[Cloudinary] Connected to cloud "${CLOUD_NAME}". Cloud media backup is ACTIVE.`);
} else {
  console.log('[Cloudinary] Credentials not set. Local uploads active as primary storage.');
}

/**
 * Upload a local file to Cloudinary with automatic resource type detection
 * @param {string} filePath - Path on disk to the uploaded file
 * @param {object} metadata - { originalname, mimetype }
 * @returns {Promise<{ url: string, publicId: string, bytes: number, format: string, resourceType: string } | null>}
 */
async function uploadToCloudinary(filePath, { originalname, mimetype } = {}) {
  if (!isCloudinaryConfigured) return null;

  try {
    let resourceType = 'auto';
    if (mimetype) {
      if (mimetype.startsWith('image/')) resourceType = 'image';
      else if (mimetype.startsWith('video/') || mimetype.startsWith('audio/')) resourceType = 'video';
      else resourceType = 'raw';
    }

    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'chatq_media',
      resource_type: resourceType,
      use_filename: true,
      unique_filename: true
    });

    console.log(`[Cloudinary] Backup uploaded successfully: ${result.secure_url || result.url}`);
    return {
      url: result.secure_url || result.url,
      publicId: result.public_id,
      bytes: result.bytes,
      format: result.format,
      resourceType: result.resource_type
    };
  } catch (err) {
    console.error('[Cloudinary] Upload backup failed (using local file):', err.message);
    return null;
  }
}

module.exports = {
  isCloudinaryConfigured,
  uploadToCloudinary
};
