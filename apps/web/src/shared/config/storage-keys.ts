/**
 * Centralized localStorage key registry.
 * All localStorage keys should be declared here to prevent collisions and typos.
 */
export const STORAGE_KEYS = {
  BACKLOG_COLUMN_WIDTHS: 'rova-backlog-col-widths',
  WI_SIDEBAR_COLLAPSED: 'wi-sidebar-collapsed',
  ITERATION_STATUS_COLUMNS: 'rova-iteration-status-columns',
  TEAM_STATUS_COLUMNS: 'rova-team-status-columns',
  RELEASES_COLUMNS: 'rova-releases-columns',
  QUALITY_COLUMNS: 'rova-quality-columns',
  MILESTONES_COLUMNS: 'rova-milestones-columns',
  PORTFOLIO_COLUMNS: 'rova-portfolio-columns',
  CAPACITY_PLAN_COLUMNS: 'rova-capacity-plan-columns',
  // v2: End Date column added — bump invalidates stale saved layouts so the new
  // column lands in its declared position (after Start Date) instead of drifting.
  PROJECTS_COLUMNS: 'rova-projects-columns-v2',
  ITERATIONS_COLUMNS: 'rova-iterations-columns',
  WORK_ITEM_TASKS_COLUMNS: 'rova-work-item-tasks-columns',
  SCM_CONNECTIONS_COLUMNS: 'rova-scm-connections-columns',
  SCM_CHANGESETS_COLUMNS: 'rova-scm-changesets-columns',
  SETTINGS_USERS_COLUMNS: 'rova-settings-users-columns',
  SETTINGS_TEAMS_COLUMNS: 'rova-settings-teams-columns',
  SETTINGS_AUDIT_COLUMNS: 'rova-settings-audit-columns',
  LAST_ACCESSED_ITERATION: 'rova-last-accessed-iteration',
  ITERATION_STATUS_VIEW_MODE: 'rova-iteration-status-view-mode',
  // Which unit the portfolio detail's "Total Accepted Children" panel opens in, set from
  // that panel's gear — Rally keeps the same choice per user.
  ACCEPTED_CHILDREN_UNIT: 'rova-accepted-children-unit',
  // Velocity chart Last 5 / Last 10 selection, preserved across reload (BA C7).
  VELOCITY_WINDOW: 'rova-velocity-window',
  // Release Tracking view selections, preserved across reload (P6-COM-006).
  RELEASE_TRACKING_UNIT: 'rova-rt-unit',
  RELEASE_TRACKING_BUCKET: 'rova-rt-bucket',
  RELEASE_TRACKING_RELEASE: 'rova-rt-release',
  // Active report type on the Reports page, preserved across reload (P6-COM-006).
  REPORTS_TYPE: 'rova-reports-type',
} as const
