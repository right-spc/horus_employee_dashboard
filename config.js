// ============================================
// HORUS DESK DASHBOARD — CONFIG
// This file is safe to share — it contains
// only the public anon key, never the service
// role key. All privileged operations go
// through the dashboard-api Edge Function.
// ============================================

const CONFIG = {
  // Found in Supabase → Project Settings → API
  supabaseUrl: 'https://oknqxlmyhmxbzqtnlraq.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rbnF4bG15aG14YnpxdG5scmFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4MDA3NTMsImV4cCI6MjA4NzM3Njc1M30.dbrWedvCASg8_JAazbaUKPYcPYwwvbYiBOpJnl7dToY',  // Public key — safe to expose
  paypalClientId: 'AbkBIwmXXoguoG6buaKcSuD0vCJI2gF_p0BrOSIzSKZ9XpYmULWoXmhz0erET6SOVhLLtmwSgMVFhtPI',  // Sandbox — swap for live key later
};
