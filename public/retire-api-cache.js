// Remove only the retired API cache when the new worker takes control.
// Database records, browser sessions and application assets are untouched.
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.delete("supabase-api-cache"));
});
