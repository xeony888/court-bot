const BASE_URL = "https://portal-lasc.journaltech.com/public-portal/";
export const RESERVATION_URL = `${BASE_URL}?q=calendar`;
const USER_AGENT = "Mozilla/5.0 (compatible; court-bot/1.0; LASC CRS availability monitor)";
// Some reservation types (for example "Notice of Hearing on Petition") reject a timeslot request without a
// name extension, and their names do not say so. Types that need no extension accept one, so every request sends it.
const NAME_EXTENSION = "Availability check";

export interface Option {
  code: string;
  name: string;
}

export interface Slot {
  /** Local Los Angeles start time, YYYY-MM-DDTHH:MM. */
  startsAt: string;
  available: number;
}

export interface SlotTarget {
  courthouseCode: string;
  courthouseName: string;
  departmentCode: string;
  departmentName: string;
  reservationTypeCode: string;
  reservationTypeName: string;
}

export class CrsError extends Error {}

/** The portal did not accept the probe case number. */
export class ProbeCaseError extends CrsError {}

/** Months since year 0, so consecutive months differ by 1. */
const monthIndex = (year: number, month: number) => year * 12 + (month - 1);

function decodeEntities(text: string): string {
  return text
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function selectOptions(html: string, selectId: string): Option[] {
  const select = html.match(new RegExp(`<select[^>]*id="${selectId}"[\\s\\S]*?</select>`));
  if (!select) throw new CrsError(`Portal page is missing select #${selectId}`);
  return parseOptions(select[0]);
}

function parseOptions(html: string): Option[] {
  return [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)/g)].map((m) => ({
    code: m[1],
    name: decodeEntities(m[2]),
  }));
}

function hiddenInputs(html: string, formId: string): Record<string, string> {
  const form = html.match(new RegExp(`<form[^>]*id="${formId}"[\\s\\S]*?</form>`));
  if (!form) throw new CrsError(`Portal page is missing form #${formId}`);
  return Object.fromEntries(
    [...form[0].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
}

function alertText(html: string): string | undefined {
  const m = html.match(/class="alert alert-(?:danger|warning|error)[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) : undefined;
}

/** Parses "11/05/2026 8:30 AM" into "2026-11-05T08:30". */
function parsePortalDateTime(value: string): string {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) throw new CrsError(`Unrecognized slot time "${value}"`);
  let hour = Number(m[4]) % 12;
  if (m[6] === "PM") hour += 12;
  return `${m[3]}-${m[1]}-${m[2]}T${String(hour).padStart(2, "0")}:${m[5]}`;
}

function parseSlots(html: string): Slot[] {
  return [...html.matchAll(/<a class="crs-btn-timeslot" data-datetime="([^"]+)"[^>]*>[\s\S]*?(\d+) available/g)].map(
    (m) => ({ startsAt: parsePortalDateTime(m[1]), available: Number(m[2]) }),
  );
}

/** Throws when an AJAX endpoint returns its JSON error envelope instead of HTML. */
function assertHtml(body: string): string {
  if (!body.trimStart().startsWith("{")) return body;
  let message = body;
  try {
    message = JSON.parse(body).message ?? body;
  } catch {
    // The body is not JSON; report it verbatim.
  }
  throw new CrsError(`Portal error: ${message}`);
}

/**
 * Logged-in portal session bound to one probe case.
 * The portal shows availability only inside a case's reservation form,
 * but it accepts any courthouse and department for that case.
 */
export class CrsSession {
  private readonly cookies = new Map<string, string>();
  private caseinfo: Record<string, unknown> = {};
  private formToken = "";
  courthouses: Option[] = [];
  reservationTypes: Option[] = [];
  caseName = "";

  private constructor() {}

  static async open(username: string, password: string, caseNumber: string): Promise<CrsSession> {
    const session = new CrsSession();
    await session.login(username, password);
    await session.openCase(caseNumber);
    return session;
  }

  private async request(path: string, form?: Record<string, string>, ajax = false): Promise<string> {
    let url = new URL(path, BASE_URL).href;
    let body: URLSearchParams | undefined = form && new URLSearchParams(form);
    for (let redirects = 0; redirects < 10; redirects++) {
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      };
      if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const eq = pair.indexOf("=");
        this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      if (res.status >= 300 && res.status < 400) {
        url = new URL(res.headers.get("location") ?? "", url).href;
        body = undefined;
        continue;
      }
      if (!res.ok) throw new CrsError(`Portal returned HTTP ${res.status} for ${path}`);
      return res.text();
    }
    throw new CrsError(`Too many redirects for ${path}`);
  }

  private async login(username: string, password: string): Promise<void> {
    const page = await this.request("?q=user");
    const result = await this.request("?q=user", {
      ...hiddenInputs(page, "user-login"),
      name: username,
      pass: password,
      op: "Log in",
    });
    if (!/<body[^>]*class="[^"]*\blogged-in\b/.test(result)) {
      throw new CrsError(`CRS login failed: ${alertText(result) ?? "unknown reason"}`);
    }
  }

  private async openCase(caseNumber: string): Promise<void> {
    const search = await this.request("?q=calendar&agree=true");
    const page = await this.request("?q=calendar/reserve", {
      ...hiddenInputs(search, "ecp-calendar-form-search"),
      caseNumber,
      op: "Submit",
    });
    const settings = page.match(/jQuery\.extend\(Drupal\.settings, (\{[\s\S]*?\})\);<\/script>/);
    const caseinfoJson = settings && JSON.parse(settings[1]).ecp_calendar?.caseinfo;
    if (!caseinfoJson) {
      throw new ProbeCaseError(`Probe case ${caseNumber} was not accepted: ${alertText(page) ?? "no case data returned"}`);
    }
    const token = page.match(/name="ecp-form-token" value="([^"]+)"/);
    const partyId = page.match(/name="ecp-calendar-partyid" value="([^"]+)"/)?.[1];
    if (!token || !partyId) throw new CrsError(`Probe case ${caseNumber} page is missing its form token or parties`);
    const partyName = page.match(new RegExp(`id="ecp-calendar-partyname-${partyId}"[^>]*>([^<]*)`))?.[1] ?? "";
    const partyRole = page.match(new RegExp(`id="ecp-calendar-partyrole-${partyId}"[^>]*>([^<]*)`))?.[1] ?? "";

    this.formToken = token[1];
    this.caseinfo = {
      ...JSON.parse(caseinfoJson),
      crsPartyId: partyId,
      crsPartyName: partyName,
      crsPartyRole: partyRole,
      crsAssertFeeExemptions: "none",
    };
    this.caseName = String(this.caseinfo.caseName ?? "");
    this.courthouses = selectOptions(page, "ecp-location-parentLocationCode");
    this.reservationTypes = selectOptions(page, "ecp-md-doctypes");
  }

  async departments(courthouseCode: string): Promise<Option[]> {
    const html = await this.request(
      "?q=calendar/locations/",
      { crsSlotParentLocationCode: courthouseCode, ecpFormToken: this.formToken },
      true,
    );
    return parseOptions(assertHtml(html));
  }

  /** Returns every open slot for the target whose date falls in [fromDate, toDate] (YYYY-MM-DD). */
  async slots(target: SlotTarget, fromDate: string, toDate: string): Promise<Slot[]> {
    const form: Record<string, string> = {};
    const fields = {
      ...this.caseinfo,
      crsSlotParentLocationCode: target.courthouseCode,
      crsSlotParentLocationName: target.courthouseName,
      crsSlotLocationCode: target.departmentCode,
      crsSlotLocationName: target.departmentName,
      crsDocumentCode: target.reservationTypeCode,
      crsDocumentName: target.reservationTypeName,
      crsDocumentNameExt: NAME_EXTENSION,
      ecpFormToken: this.formToken,
    };
    for (const [key, value] of Object.entries(fields)) form[key] = String(value ?? "");

    const first = assertHtml(await this.request("?q=calendar/timeslots/", form, true));
    // "YYYY-M-N": first bookable month and the number of months the portal offers.
    const range = first.match(/id="ecp-calendar-timeslot-range"[^>]*value="(\d{4})-(\d{1,2})-(\d+)"/);
    if (!range) throw new CrsError("Timeslot response is missing the bookable month range");
    const firstBookable = monthIndex(Number(range[1]), Number(range[2]));
    const lastBookable = firstBookable + Number(range[3]) - 1;

    const wantFrom = monthIndex(Number(fromDate.slice(0, 4)), Number(fromDate.slice(5, 7)));
    const wantTo = monthIndex(Number(toDate.slice(0, 4)), Number(toDate.slice(5, 7)));

    const pages: string[] = [];
    for (let i = Math.max(firstBookable, wantFrom); i <= Math.min(lastBookable, wantTo); i++) {
      if (i === firstBookable) {
        pages.push(first);
        continue;
      }
      const monthSelect = `${Math.floor(i / 12)}-${(i % 12) + 1}`;
      pages.push(assertHtml(await this.request("?q=calendar/timeslotMonth", { ...form, monthSelect }, true)));
    }

    // Calendar grids include padding days from adjacent months, so slots can repeat across pages.
    const byStart = new Map<string, Slot>();
    for (const slot of pages.flatMap(parseSlots)) {
      const date = slot.startsAt.slice(0, 10);
      if (date >= fromDate && date <= toDate) byStart.set(slot.startsAt, slot);
    }
    return [...byStart.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
}
