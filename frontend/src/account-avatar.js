export function getAccountPhotoUrls(user, preferredPhotoUrl = '') {
  const providerPhotos = user?.providerData?.map(profile => profile.photoURL).filter(Boolean) || [];
  const googlePhotoUrl = user?.providerData?.find(profile => profile.providerId === 'google.com')?.photoURL;
  return [...new Set([preferredPhotoUrl, googlePhotoUrl, user?.photoURL, ...providerPhotos]
    .filter(photoUrl => typeof photoUrl === 'string' && photoUrl.trim()))];
}

export function getAccountPhotoUrl(user) {
  return getAccountPhotoUrls(user)[0] || '';
}

export function setAccountAvatar(element, initial, photoUrls = '') {
  if (!element) return;
  const candidates = [...new Set((Array.isArray(photoUrls) ? photoUrls : [photoUrls])
    .filter(photoUrl => typeof photoUrl === 'string' && photoUrl.trim()))];
  const currentImage = element.querySelector('img');
  if (currentImage && candidates[0] && currentImage.getAttribute('src') === candidates[0]) return;
  element.replaceChildren();
  if (!candidates.length) {
    element.textContent = initial;
    return;
  }

  const image = document.createElement('img');
  let candidateIndex = 0;
  image.alt = '';
  image.draggable = false;
  image.loading = 'eager';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => {
    candidateIndex++;
    if (candidateIndex < candidates.length) {
      image.src = candidates[candidateIndex];
      return;
    }
    image.remove();
    element.textContent = initial;
  });
  element.append(image);
  image.src = candidates[candidateIndex];
}
