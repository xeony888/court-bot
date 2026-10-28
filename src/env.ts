function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  crsUsername: required("CRS_USERNAME"),
  crsPassword: required("CRS_PASSWORD"),
  dashboardPassword: required("DASHBOARD_PASSWORD"),
  gmailUser: required("GMAIL_USER"),
  gmailAppPassword: required("GMAIL_APP_PASSWORD"),
  port: Number(process.env.PORT ?? 3000),
};
