const form = document.getElementById("order-form");
const error = document.getElementById("error");
const submit = document.getElementById("submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  submit.disabled = true;
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create the order.");
    location.href = data.url;
  } catch (err) {
    error.textContent = err.message;
    submit.disabled = false;
  }
});
