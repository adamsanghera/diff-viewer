// A classic script in <head>: it applies the saved theme and panel choices before the first paint, so neither flashes.
(function () {
  var pref = localStorage.getItem("diffview.theme") || "auto";
  var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // Keep in step with PANELS in sidebar.js.
  if (localStorage.getItem("diffview.panel.stack") === "hidden") document.documentElement.classList.add("no-stack");
  if (localStorage.getItem("diffview.panel.files") === "hidden") document.documentElement.classList.add("no-files");
})();
