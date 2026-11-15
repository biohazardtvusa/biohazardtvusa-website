(() => {
  const navLinks = document.querySelector(".nav .links");
  const referralSection = document.querySelector(".referral-band");

  if (!navLinks || !referralSection) return;

  if (!referralSection.id) referralSection.id = "referral";

  const referralLinks = [...navLinks.querySelectorAll("a")].filter(
    (link) => link.textContent.trim().toLowerCase() === "refer a friend",
  );

  const referralLink = referralLinks.shift() || document.createElement("a");
  referralLink.href = `#${referralSection.id}`;
  referralLink.textContent = "Refer a Friend";

  for (const duplicate of referralLinks) duplicate.remove();

  const contactLink = [...navLinks.querySelectorAll("a")].find(
    (link) => link.textContent.trim().toLowerCase() === "contact",
  );

  if (contactLink) {
    contactLink.after(referralLink);
  } else if (!referralLink.isConnected) {
    navLinks.append(referralLink);
  }
})();
