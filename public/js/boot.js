// A classic script in <head>: it applies the saved theme and sidebar state before the first paint, so neither flashes.
(function () {
  var pref = localStorage.getItem("diffview.theme") || "auto";
  var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (localStorage.getItem("diffview.sidebar") === "hidden") document.documentElement.classList.add("no-sidebar");
})();
