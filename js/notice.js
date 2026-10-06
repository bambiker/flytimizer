// Short messages shown in the page, next to the control they're about,
// instead of a blocking alert() box. Each place has its own empty
// container in index.html (searchNotice, calcNotice, resultNotice).

// Shows `message` in the container with this id. With opts.copyText,
// also shows that text in a read-only box, selected, ready to copy.
export function showNotice(id, message, opts){
  var box = document.getElementById(id);
  if (!box) return;
  opts = opts || {};
  box.textContent = '';
  var text = document.createElement('span');
  text.textContent = message;
  box.appendChild(text);
  var copy = null;
  if (opts.copyText){
    copy = document.createElement('input');
    copy.type = 'text';
    copy.readOnly = true;
    copy.className = 'notice-copy';
    copy.value = opts.copyText;
    copy.setAttribute('aria-label', message);
    box.appendChild(copy);
  }
  var close = document.createElement('button');
  close.type = 'button';
  close.className = 'notice-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', function(){ hideNotice(id); });
  box.appendChild(close);
  box.hidden = false;
  if (copy){ copy.focus(); copy.select(); }
}

export function hideNotice(id){
  var box = document.getElementById(id);
  if (box){ box.hidden = true; box.textContent = ''; }
}
