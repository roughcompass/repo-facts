import { slugify } from "./vendor/strings.js";

window.addEventListener("message", (event) => {
  if (event.data?.type === "route") document.title = slugify(event.data.name);
});
