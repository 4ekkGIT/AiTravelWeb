// ===================== BURGER MENU =====================
const burger = document.getElementById("burger");
const navLinks = document.getElementById("nav-links");

burger.addEventListener("click", () => {
  navLinks.classList.toggle("active");
});

// ===================== SLIDER DRAG =====================
const track = document.getElementById("toursContainer");

document.getElementById("slideLeft").addEventListener("click", () => {
  track.scrollBy({ left: -300, behavior: "smooth" });
});

document.getElementById("slideRight").addEventListener("click", () => {
  track.scrollBy({ left: 300, behavior: "smooth" });
});

let isDown = false;
let startX;
let scrollLeft;

track.addEventListener("mousedown", (e) => {
  isDown = true;
  startX = e.pageX - track.offsetLeft;
  scrollLeft = track.scrollLeft;
});

track.addEventListener("mouseleave", () => isDown = false);
track.addEventListener("mouseup",    () => isDown = false);

track.addEventListener("mousemove", (e) => {
  if (!isDown) return;
  e.preventDefault();
  const x    = e.pageX - track.offsetLeft;
  const walk = (x - startX) * 2;
  track.scrollLeft = scrollLeft - walk;
});

// ===================== NAV ADMIN BUTTON =====================
// Renders the correct button in the top-right navbar area
// depending on whether the admin session is active.
// Called once on load, and again after login/logout.

function renderNavAdmin() {
  const area       = document.getElementById("navAdminArea");
  const isLoggedIn = sessionStorage.getItem("aitravel_admin_session") === "true";

  if (isLoggedIn) {
    area.innerHTML = `
      <button class="nav-admin-btn nav-admin-btn--manage"
              onclick="hotToursAdmin.openAddModal()">
        ⚙ Управление турами
      </button>
      <button class="nav-admin-btn nav-admin-btn--logout"
              onclick="hotToursAdmin.logout()">
        Выйти
      </button>
    `;
  } else {
    area.innerHTML = `
      <a href="admin.html" class="nav-admin-btn nav-admin-btn--login">
        🔒 Войти как админ
      </a>
    `;
  }
}

// Run on page load
document.addEventListener("DOMContentLoaded", renderNavAdmin);

const observer = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.15 });
document.querySelectorAll('.fade-section').forEach(el => observer.observe(el));