export function parseResumeProjectJson(source) {
  if (new TextEncoder().encode(source).length > 5 * 1024 * 1024) {
    throw new Error('Resume project JSON files must be smaller than 5 MB.');
  }
  let project;
  try {
    project = JSON.parse(source);
  } catch (error) {
    throw new Error('This JSON file is not valid.', { cause: error });
  }
  if (!project || typeof project !== 'object' || Array.isArray(project)
    || !project.profile || typeof project.profile !== 'object'
    || !Array.isArray(project.sections)
    || !project.design || typeof project.design !== 'object') {
    throw new Error('This JSON file does not contain a valid ResumeOut.com resume project.');
  }
  return project;
}
