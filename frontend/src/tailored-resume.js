function cleanText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

export function createTailoredResumeCopy(resume, {
  name,
  jobTitle = '',
  company = '',
  jobDescription = '',
  sourceResumeId = ''
} = {}) {
  const copyName = cleanText(name, 120);
  if (!copyName) throw new Error('Enter a name for this tailored version.');
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
    throw new Error('A valid resume is required to create a tailored version.');
  }
  return {
    ...structuredClone(resume),
    docName: copyName,
    tailoredFor: {
      jobTitle: cleanText(jobTitle, 120),
      company: cleanText(company, 120),
      jobDescription: String(jobDescription || '').slice(0, 12000),
      sourceResumeId: cleanText(sourceResumeId, 200)
    }
  };
}

export function resumeStateForPdfExport(resume) {
  const { tailoredFor, ...exportState } = resume;
  return exportState;
}
