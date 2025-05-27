const express = require("express");
const puppeteer = require("puppeteer");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

let otpPage = null;
let browserInstance = null;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  browserInstance = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // Required for cPanel
    slowMo: 50,
  });
  const page = await browserInstance.newPage();
  otpPage = page;

  await page.goto("https://oga.fasah.sa/en/login/1.0/", {
    waitUntil: "networkidle2",
  });

  try {
    await page.waitForSelector('input[name="username"]:not([disabled])', {
      visible: true,
    });
    await page.type('input[name="username"]', email);

    await page.waitForSelector(
      'input[placeholder="Password"]:not([disabled])',
      { visible: true }
    );
    await page.type('input[placeholder="Password"]', password);

    await page.waitForSelector("#login_send_otp_via_1", { visible: true });
    await page.click("#login_send_otp_via_1");
    await new Promise((resolve) => setTimeout(resolve, 500));

    await page.click("button.btn.btn-primary.btn-rounded");

    await page.waitForSelector('[role="alert"]', { timeout: 5000 });

    const alertMessage = await page.$eval(
      '[role="alert"]',
      (el) => el.innerText
    );

    if (alertMessage.includes("Username/Password is incorrect")) {
      await browserInstance.close();
      return res.send(`<h2 style="color:red;">${alertMessage}</h2>`);
    }

    if (alertMessage.includes("A temporary password sent to email")) {
      await page.waitForSelector('input[name="otp"]', { visible: true });
      return res.send(`
        <h2 style="color:green;">✅ ${alertMessage}</h2>
        <p>OTP is valid for a short time — please enter it below:</p>
        <form method="POST" action="/submit-otp">
          <input type="text" name="otp" placeholder="Enter OTP" required minlength="6" maxlength="6" />
          <button type="submit">Verify OTP</button>
        </form>
      `);
    }

    return res.send(`<h2>Received message: ${alertMessage}</h2>`);
  } catch (err) {
    return res.send(
      `<h2 style="color:red;">⚠️ No response received. Login may have failed.</h2>`
    );
  }
});

app.post("/submit-otp/bill-search", async (req, res) => {
  const { otp, manifest_port, bill_number } = req.body;

  if (!otpPage) return res.send("Session expired.");

  try {
    await otpPage.type('input[name="otp"]', otp);
    await otpPage.click("button.btn.btn-primary");

    // scraping process after OTP verification

    // Wait for dashboard container visible
    await otpPage.waitForSelector(
      "#broker_dashboard_fasah.container-fluid.mt-4",
      { visible: true }
    );

    // Wait for loader to disappear
    await otpPage.waitForFunction(
      () => !document.documentElement.classList.contains("nprogress-busy"),
      { timeout: 10000 }
    );

    // Wait for nav item visible
    await otpPage.waitForSelector("#package-list > li:nth-child(19) > div", {
      visible: true,
    });

    // Click nav
    await otpPage.click("#package-list > li:nth-child(19) > div");

    // Wait for the "Bill Search" page title to appear (SPA navigation)
    await otpPage.waitForSelector("h1.header span.title", {
      visible: true,
      timeout: 15000,
    });

    // Get page title text
    const pageTitle = await otpPage.$eval(
      "h1.header span.title",
      (el) => el.innerText
    );
    console.log("Page title:", pageTitle);

    if (pageTitle.trim() === "Bill Search") {
      // 1. Check the airport radio
      await otpPage.waitForSelector("#broker_port_type_1", { visible: true });
      await otpPage.click("#broker_port_type_1");
      console.log("✅ Selected 'Air port' radio");

      // 2. Type 23 in the autocomplete input (even if disabled, try removing 'disabled' if needed)
      await otpPage.evaluate(() => {
        const input = document.querySelector(
          'input[test-attr="broker_manifest_port"]'
        );
        input.removeAttribute("disabled"); // remove disabled if needed
      });
      await otpPage.type(
        'input[test-attr="broker_manifest_port"]',
        manifest_port
      );
      await otpPage.waitForSelector("li.autocomplete-result", {
        visible: true,
      });
      await otpPage.click("li.autocomplete-result");
      console.log("✅ Selected airport from autocomplete");

      // Wait for the select element to be visible
      await otpPage.waitForSelector('[test-attr="broker_manifest_type"]', {
        visible: true,
      });

      // Click the select to open options
      await otpPage.click('[test-attr="broker_manifest_type"]');

      // Use page.evaluate to select the option by its data-id
      await otpPage.evaluate(() => {
        const options = document.querySelectorAll(
          '[test-attr="broker_manifest_type"] option'
        );
        for (const option of options) {
          if (option.getAttribute("data-id") === "1") {
            option.selected = true;
            const event = new Event("change", { bubbles: true });
            option.parentElement.dispatchEvent(event); // trigger change event
            break;
          }
        }
      });
      console.log("✅ 'Import Manifest' option selected");

      // 4. Type the bill number
      await otpPage.waitForSelector('[test-attr="broker_bill_number"]', {
        visible: true,
      });
      await otpPage.type('[test-attr="broker_bill_number"]', bill_number);
      console.log("✅ Entered Bill Number");

      // Optional: Submit the form or click a search button (if any)
      await otpPage.click('button[data-i18n="Search"]');

      console.log("✅ Clicked Search button");

      // Wait for the results table to be visible

      // ✅ 1. Trigger the search first (your custom search trigger here)
      // await otpPage.click(...); or form fill code

      // ✅ 2. Wait for the result row with data-obj to appear
      await otpPage.waitForSelector("table.fgrid tbody tr[data-obj]", {
        timeout: 15000,
      });

      // ✅ 3. Scrape the table data
      const results = await otpPage.evaluate(() => {
        return Array.from(
          document.querySelectorAll("table.fgrid tbody tr[data-obj]")
        ).map((row) => JSON.parse(row.getAttribute("data-obj")));
      });

      res.json({
        success: true,
        message: "✅ Bill data retrieved successfully",
        results, // Send scraped data
      });
    } else {
      res.json({
        success: false,
        message: `⚠️ Unexpected page title: ${pageTitle}`,
      });
    }
  } catch (err) {
    res.json({
      success: false,
      message: "⚠️ Failed to retrieve bill data",
      error: err.message,
    });
  }
});

app.post("/submit-otp/import-declaration", async (req, res) => {
  const { otp, import_declaration } = req.body;

  if (!otpPage)
    return res.json({
      success: false,
      message: "Session expired. Please restart the process.",
    });

  try {
    // Existing OTP verification and navigation code
    await otpPage.type('input[name="otp"]', otp);
    await otpPage.click("button.btn.btn-primary");

    // Wait for dashboard
    await otpPage.waitForSelector(
      "#broker_dashboard_fasah.container-fluid.mt-4",
      {
        visible: true,
        timeout: 15000,
      }
    );

    // Wait for loader
    await otpPage.waitForFunction(
      () => !document.documentElement.classList.contains("nprogress-busy"),
      { timeout: 10000 }
    );

    // Navigation to Import Declaration
    await otpPage.waitForSelector("#package-list > li:nth-child(2) > div", {
      visible: true,
      timeout: 15000,
    });
    await otpPage.click("#package-list > li:nth-child(2) > div");

    // Verify page title
    await otpPage.waitForSelector("h1.header span.title", {
      visible: true,
      timeout: 15000,
    });

    const pageTitle = await otpPage.$eval("h1.header span.title", (el) =>
      el.innerText.trim()
    );

    if (pageTitle === "Import Declaration") {
      // Perform search and scraping
      await otpPage.evaluate(() => {
        const input = document.querySelector(
          "#broker_declaration_import input[placeholder='Search']"
        );
        input.removeAttribute("disabled");
      });

      await otpPage.type(
        "#broker_declaration_import input[placeholder='Search']",
        import_declaration
      );

      // Wait for results
      await otpPage.waitForSelector("table.fgrid tbody tr[data-obj]", {
        timeout: 15000,
      });

      // Scrape data
      const results = await otpPage.evaluate(() => {
        return Array.from(
          document.querySelectorAll("table.fgrid tbody tr[data-obj]")
        ).map((row) => JSON.parse(row.getAttribute("data-obj")));
      });

      res.json({
        success: true,
        message: "Import declaration data retrieved successfully",
        data: results,
      });
    } else {
      res.json({
        success: false,
        message: `Unexpected page: ${pageTitle}`,
      });
    }
  } catch (error) {
    console.error("Import declaration error:", error);
    res.json({
      success: false,
      message: "Failed to retrieve import declaration data",
      error: error.message,
    });
  }
});

app.listen(process.env.PORT, () => {
  // cPanel assigns the port automatically
  console.log("Server running");
});
