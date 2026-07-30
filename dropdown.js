// The little `▾` menus in the headers. There is more than one of them, and the
// only interesting part is that they agree: opening one closes the rest, a
// click anywhere else closes all of them, and so does Escape.

const dropdowns = [];

function closeAll(except) {
  for (const dropdown of dropdowns) {
    if (dropdown !== except) dropdown.close();
  }
}

/**
 * Wire `toggle` (a button) to `list` (a `ul.dropdown-list`). `fill` rebuilds
 * the list's items and runs on every open, so a menu never shows a stale set.
 *
 * `hiddenHost` is the element that carries the open/closed `hidden` state -
 * normally `list` itself, but a caller whose CSS needs to key off open/closed
 * (e.g. rounding a container's corners only while its dropdown is shut) can
 * pass an ancestor instead.
 */
export function setupDropdown(toggle, list, fill, hiddenHost = list) {
  const dropdown = {
    list,
    open() {
      closeAll(dropdown);
      fill();
      hiddenHost.hidden = false;
    },
    close() {
      hiddenHost.hidden = true;
    },
  };

  toggle.addEventListener("click", event => {
    // Without this the document listener below sees the same click and closes
    // the menu we are about to open.
    event.stopPropagation();
    if (hiddenHost.hidden) dropdown.open();
    else dropdown.close();
  });

  dropdowns.push(dropdown);
  return dropdown;
}

/** An `li` for a dropdown, marked `current` when it is the active choice. */
export function dropdownItem(text, current, onPick) {
  const item = document.createElement("li");
  item.textContent = text;
  if (current) item.classList.add("current");
  item.addEventListener("click", onPick);
  return item;
}

/** An unclickable placeholder line, for a menu with nothing in it. */
export function dropdownPlaceholder(text) {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

document.addEventListener("click", event => {
  for (const dropdown of dropdowns) {
    if (!dropdown.list.contains(event.target)) dropdown.close();
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeAll();
});
