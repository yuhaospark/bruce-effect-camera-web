const $ = (id) => document.getElementById(id);
let config = { mode: 'none', blurRadius: 15, backgroundImage: null };

function render() {
  document.querySelectorAll('#modes button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === config.mode);
  });
  $('blurRow').style.display = config.mode === 'blur' ? '' : 'none';
  $('imageRow').style.display = config.mode === 'image' ? '' : 'none';
  $('blur').value = config.blurRadius;
  $('blurValue').textContent = config.blurRadius;
  $('preview').style.backgroundImage = config.backgroundImage ? `url(${config.backgroundImage})` : '';
}

function save() {
  chrome.storage.local.set({ config });
}

chrome.storage.local.get(['config'], (res) => {
  if (res.config) config = res.config;
  render();
});

document.querySelectorAll('#modes button').forEach(b => {
  b.addEventListener('click', () => {
    config.mode = b.dataset.mode;
    render(); save();
  });
});

$('blur').addEventListener('input', (e) => {
  config.blurRadius = parseInt(e.target.value, 10);
  $('blurValue').textContent = config.blurRadius;
  save();
});

$('pickImage').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    config.backgroundImage = reader.result; // data: URL — survives cross-origin
    render(); save();
  };
  reader.readAsDataURL(file);
});

$('clearImage').addEventListener('click', () => {
  config.backgroundImage = null;
  render(); save();
});
