export const RESUME_PDF_METADATA_NAMESPACE = 'https://resumeout.com/ns/resume/1.0/';
const LEGACY_RESUME_PDF_METADATA_NAMESPACE = 'https://personacraftpro.com/ns/resume/1.0/';

export function readEmbeddedResumeProject(metadata) {
  const rawData = metadata?.getRaw?.();
  const payload = metadata?.get?.('jspdf:metadata');
  const hasResumeNamespace = typeof rawData === 'string'
    && [RESUME_PDF_METADATA_NAMESPACE, LEGACY_RESUME_PDF_METADATA_NAMESPACE]
      .some(namespace => rawData.includes(`xmlns:jspdf="${namespace}"`));
  if (!hasResumeNamespace || !payload) return null;

  let record;
  try {
    record = JSON.parse(payload);
  } catch (error) {
    throw new Error('This ResumeOut.com PDF contains unreadable resume data. Please export it again or import another file.', { cause: error });
  }
  if (!['ResumeOut.comResume', 'PersonaCraftProResume'].includes(record?.format)
    || record.version !== 1 || !record.resume || typeof record.resume !== 'object') {
    throw new Error('This ResumeOut.com PDF contains an unsupported resume-data version. Please export it again or import another file.');
  }
  return record.resume;
}
