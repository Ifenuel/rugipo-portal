const FACULTY_MAP = {
  'Computer Science': 'faculty_sci_eng',
  'Civil Engineering': 'faculty_sci_eng',
  'Computer Engineering': 'faculty_sci_eng',
  'Electrical Engineering': 'faculty_sci_eng',
  'Mechanical Engineering': 'faculty_sci_eng',
  'Science Laboratory Technology': 'faculty_sci_eng',
  'Statistics': 'faculty_sci_eng',

  'Accountancy': 'faculty_business',
  'Business Administration': 'faculty_business',
  'Marketing': 'faculty_business',
  'Mass Communication': 'faculty_business',
  'Public Administration': 'faculty_business',
  'Office Technology and Management': 'faculty_business',

  'Building Technology': 'faculty_env_agric',
  'Estate Management': 'faculty_env_agric',
  'Quantity Surveying': 'faculty_env_agric',
  'Agricultural Technology': 'faculty_env_agric',
  'Crop Production Technology': 'faculty_env_agric'
};

const FACULTY_LABELS = {
  faculty_sci_eng: 'Science & Engineering',
  faculty_business: 'Business & Management',
  faculty_env_agric: 'Environmental & Agricultural'
};

module.exports = { FACULTY_MAP, FACULTY_LABELS };