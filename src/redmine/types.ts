// Redmine API response types

export interface RedmineIssue {
  id: number;
  project: RedmineRef;
  tracker: RedmineRef;
  status: RedmineRef;
  priority: RedmineRef;
  author: RedmineRef;
  assigned_to?: RedmineRef;
  category?: RedmineRef;
  fixed_version?: RedmineRef;
  parent?: RedmineRef;
  subject: string;
  description: string;
  start_date?: string;
  due_date?: string;
  done_ratio: number;
  is_private: boolean;
  estimated_hours?: number;
  spent_hours?: number;
  created_on: string;
  updated_on: string;
  closed_on?: string;
  journals?: RedmineJournal[];
  children?: RedmineChildIssue[];
  relations?: RedmineRelation[];
  custom_fields?: RedmineCustomField[];
  attachments?: RedmineAttachment[];
  watchers?: RedmineRef[];
}

export interface RedmineRef {
  id: number;
  name: string;
}

export interface RedmineJournal {
  id: number;
  user: RedmineRef;
  notes: string;
  created_on: string;
  details: RedmineJournalDetail[];
}

export interface RedmineJournalDetail {
  property: string;
  name: string;
  old_value?: string;
  new_value?: string;
}

export interface RedmineChildIssue {
  id: number;
  tracker: RedmineRef;
  subject: string;
  status?: RedmineRef;
}

export interface RedmineRelation {
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type: string;
  delay?: number;
}

export interface RedmineMembership {
  id: number;
  project: RedmineRef;
  user?: RedmineRef;
  group?: RedmineRef;
  roles: RedmineRef[];
}

export interface RedmineCustomField {
  id: number;
  name: string;
  value: string | string[];
}

export interface RedmineProject {
  id: number;
  name: string;
  identifier: string;
  description: string;
  status: number;
  is_public: boolean;
  created_on: string;
  updated_on: string;
  trackers?: RedmineRef[];
  issue_categories?: RedmineRef[];
  enabled_modules?: RedmineRef[];
  time_entry_activities?: RedmineRef[];
}

export interface RedmineUser {
  id: number;
  login: string;
  firstname: string;
  lastname: string;
  mail: string;
  created_on: string;
  last_login_on?: string;
  status?: number;
}

export interface RedmineTimeEntry {
  id: number;
  project: RedmineRef;
  issue?: RedmineRef;
  user: RedmineRef;
  activity: RedmineRef;
  hours: number;
  comments: string;
  spent_on: string;
  created_on: string;
  updated_on: string;
}

export interface RedmineVersion {
  id: number;
  project: RedmineRef;
  name: string;
  description: string;
  status: string;
  due_date?: string;
  sharing: string;
  created_on: string;
  updated_on: string;
}

export interface RedminePaginatedResponse<T> {
  total_count: number;
  offset: number;
  limit: number;
  items: T[];
}

export interface RedmineAttachment {
  id: number;
  filename: string;
  filesize: number;
  content_type: string;
  description: string;
  content_url: string;
  thumbnail_url?: string;
  author: RedmineRef;
  created_on: string;
}
