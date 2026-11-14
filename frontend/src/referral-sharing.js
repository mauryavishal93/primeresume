const defaultReferralUrl = 'https://www.resumeout.com/';

export function buildReferralShareMessage(referralUrl, referralCode = '') {
  const shareUrl = typeof referralUrl === 'string' && referralUrl.trim()
    ? referralUrl.trim()
    : defaultReferralUrl;
  const codeLine = typeof referralCode === 'string' && referralCode.trim()
    ? `\nYour referral code: ${referralCode.trim()}\n`
    : '';

  return `🎯 Looking for a job? Let your resume do the talking!

Introducing ResumeOut – an easy way to create professional resumes and cover letters.

✨ Build professional resumes
✨ Choose from multiple templates
✨ Create tailored resumes for different job opportunities
✨ Prepare compelling cover letters

💻 For the best experience, we recommend using ResumeOut on a desktop or laptop.

🚀 Get started today:
${shareUrl}
${codeLine}
Give it a try and share it with anyone looking for a new job opportunity!

ResumeOut – Your Next Career Move Starts Here! 😊`;
}

export function buildReferralShareUrl(service, message, referralUrl) {
  const encodedMessage = encodeURIComponent(message);
  const encodedUrl = encodeURIComponent(referralUrl);
  const shareUrls = {
    whatsapp: `https://wa.me/?text=${encodedMessage}`,
    telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedMessage}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    x: `https://twitter.com/intent/tweet?text=${encodedMessage}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}&text=${encodedMessage}`
  };
  return shareUrls[service];
}
