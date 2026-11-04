const feedbackForm = document.querySelector('#feedbackForm');

feedbackForm?.addEventListener('submit', event => {
  event.preventDefault();
  const formData = new FormData(feedbackForm);
  const senderName = String(formData.get('name') || '').trim();
  const senderEmail = String(formData.get('email') || '').trim();
  const message = String(formData.get('message') || '').trim();
  const body = [
    senderName ? `Name: ${senderName}` : '',
    senderEmail ? `Email: ${senderEmail}` : '',
    '',
    'Feedback:',
    message
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  const subject = encodeURIComponent('ResumeOut.com feedback');
  window.location.href = `mailto:buildymyportfolio@gmail.com?subject=${subject}&body=${encodeURIComponent(body)}`;
});