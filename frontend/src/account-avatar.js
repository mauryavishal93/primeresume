export function setAccountAvatar(element, initial, photoUrl = '') {
  if (!element) return;
  element.replaceChildren();
  if (photoUrl) {
    const image = document.createElement('img');
    image.src = photoUrl;
    image.alt = '';
    image.draggable = false;
    image.addEventListener('error', () => {
      image.remove();
      element.textContent = initial;
    }, { once: true });
    element.append(image);
  } else {
    element.textContent = initial;
  }
}
