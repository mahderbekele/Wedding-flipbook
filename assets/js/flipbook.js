/* =============================================================================
   Haymi & Messi — wedding flipbook

   A page-turning album built on CSS 3D transforms.

   The book is a stack of *leaves*. Each leaf is a sheet of paper with two
   printed sides, hinged on its left edge:

       leaf k  ->  front = pages[2k]   (the right-hand page of a spread)
                   back  = pages[2k+1] (the left-hand page of the next spread)

   `state.pos` is simply how many leaves have been turned. On a narrow screen
   the same machinery runs with one page per leaf, so only a single page shows
   at a time.
   ============================================================================= */

(function () {
  "use strict";

  var photos = window.WEDDING_PHOTOS || [];

  var COUPLE = { one: "Haymi", two: "Messi" };
  var SPREAD_MIN_W = 800;      /* px of stage width needed for a two-page spread */
  var SPREAD_MIN_H = 420;
  var MAX_PAGE_RATIO = 0.95;   /* keep pages upright on very wide windows */
  var HYDRATE_PAD  = 4;        /* pages either side of the current one to load   */
  var AUTOPLAY_MS  = 5200;
  var STRIPS       = 14;       /* vertical slices the turning page bends along */
  var LAG          = 0.18;     /* how far the spine trails the free edge, 0 = rigid */
  var FILL_LIMIT   = 0.45;     /* crop this much of a photo, but no more */
  var IDLE_MS      = 3200;     /* quiet time before the controls fade away */

  /* ---------------------------------------------------------------------------
     Running order and pagination

     A landscape photograph gets a whole spread to itself rather than being
     squeezed onto one upright page — printed across the gutter, the way an
     album does it, so nothing is cropped and no page carries empty margins.

     A spread begins on a left-hand page, which is an odd slot, so the running
     order is nudged to suit: where a wide frame would land on a right-hand
     page, the next upright one is brought forward to face it instead of
     leaving a blank. The order is settled once and used by both layouts, so a
     photograph keeps its number whether it is read as a spread or one page at
     a time.
     ------------------------------------------------------------------------- */

  function packForSpreads(list) {
    var queue = list.slice();
    var out = [];
    var slot = 1;                       /* slot 0 is the cover */

    while (queue.length) {
      var wide = queue[0].o === "landscape";

      if (wide && slot % 2 === 0) {
        var j = -1;
        for (var k = 1; k < queue.length; k++) {
          if (queue[k].o !== "landscape") { j = k; break; }
        }
        if (j < 0) break;               /* nothing upright left to face it */
        out.push(queue.splice(j, 1)[0]);
        slot += 1;
        continue;
      }

      out.push(queue.shift());
      slot += wide ? 2 : 1;
    }
    return out.concat(queue);
  }

  /* A chapter title belongs on the first photograph of its chapter. Packing can
     carry a later frame forward past the one that opened it, so the titles are
     re-hung on whichever photograph now comes first. */
  function rehangChapters(original, packed) {
    var chapters = [];
    var group = -1;
    var i;

    for (i = 0; i < original.length; i++) {
      if (original[i].chapter) {
        group++;
        chapters.push({ chapter: original[i].chapter, caption: original[i].caption });
      }
      original[i].group = group;
    }
    for (i = 0; i < packed.length; i++) {
      delete packed[i].chapter;
      delete packed[i].caption;
    }
    var seen = {};
    for (i = 0; i < packed.length; i++) {
      var g = packed[i].group;
      if (g < 0 || seen[g]) continue;
      seen[g] = true;
      packed[i].chapter = chapters[g].chapter;
      packed[i].caption = chapters[g].caption;
    }
  }

  var album = packForSpreads(photos);
  rehangChapters(photos, album);
  album.forEach(function (photo, i) { photo.no = i + 1; });

  var TOTAL_PHOTOS = album.length;
  var pages = [];

  function buildPageList(mode) {
    var list = [{ type: "cover" }];

    album.forEach(function (photo) {
      var wide = mode === "spread" && photo.o === "landscape";

      /* Belt and braces: a spread can only start on a left-hand page. */
      if (wide && list.length % 2 === 0) list.push({ type: "blank" });

      if (wide) {
        list.push({ type: "photo", photo: photo, no: photo.no, half: "left" });
        list.push({ type: "photo", photo: photo, no: photo.no, half: "right" });
      } else {
        list.push({ type: "photo", photo: photo, no: photo.no });
      }
    });

    list.push({ type: "end" });
    list.push({ type: "back" });        /* the outside of the back cover */

    /* Leaves come in pairs, but only a spread needs them to. */
    if (mode === "spread" && list.length % 2) list.push({ type: "blank" });
    return list;
  }

  function pageOfPhoto(no) {
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].type === "photo" && pages[i].no === no) return i;
    }
    return 0;
  }

  /* Which photographs the reader can see right now. */
  function visiblePhotoNos() {
    var out = [];
    var seen = {};
    var idx = state.mode === "spread"
      ? [state.pos * 2 - 1, state.pos * 2]
      : [state.pos];

    idx.forEach(function (i) {
      var page = pages[i];
      if (!page || page.type !== "photo" || seen[page.no]) return;
      seen[page.no] = true;
      out.push(page.no);
    });
    return out;
  }

  /* ---------------------------------------------------------------------------
     Element references
     ------------------------------------------------------------------------- */

  var el = {
    app:       document.querySelector(".app"),
    stage:     document.querySelector(".stage"),
    book:      document.querySelector(".book"),
    prev:      document.querySelector(".nav--prev"),
    next:      document.querySelector(".nav--next"),
    counter:   document.querySelector(".counter"),
    contents:  document.querySelector(".contents"),
    grid:      document.querySelector(".contents__grid"),
    openIndex: document.querySelector('[data-action="contents"]'),
    closeIdx:  document.querySelector('[data-action="contents-close"]'),
    play:      document.querySelector('[data-action="autoplay"]'),
    full:      document.querySelector('[data-action="fullscreen"]'),
    veil:      document.querySelector(".veil"),
    veilBar:   document.querySelector(".veil__bar span"),
    live:      document.querySelector("#live")
  };

  var state = {
    mode: "spread",
    pos: 0,            /* leaves turned */
    turning: false,
    pending: 0,
    autoplay: false,
    timer: null
  };

  var leaves = [];     /* DOM nodes, index-aligned with leaf number */
  var nLeaves = 0;
  var turnMs = 900;

  /* ---------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------- */

  function h(tag, cls, attrs) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* pages-per-leaf for the current mode */
  function stride() { return state.mode === "spread" ? 2 : 1; }

  function maxPos() {
    return state.mode === "spread" ? nLeaves : pages.length - 1;
  }

  /* The page a reader would say they are "on". */
  function primaryPage() {
    return state.mode === "spread"
      ? Math.min(state.pos * 2, pages.length - 1)
      : state.pos;
  }

  function posForPage(pageIndex) {
    return state.mode === "spread"
      ? clamp(Math.ceil(pageIndex / 2), 0, nLeaves)
      : clamp(pageIndex, 0, pages.length - 1);
  }

  /* ---------------------------------------------------------------------------
     Page rendering
     ------------------------------------------------------------------------- */

  function buildPage(page, side) {
    if (!page) return buildBlank(side);

    switch (page.type) {
      case "cover": return buildCover();
      case "end":   return buildEnd();
      case "back":  return buildBack();
      case "photo": return buildPhoto(page, side);
      default:      return buildBlank(side);
    }
  }

  function buildBlank(side) {
    var p = h("div", "page page--blank", { "data-side": side });
    return p;
  }

  function ornament() {
    var o = h("div", "ornament");
    o.appendChild(h("span", "ornament__mark")).textContent = "❦";
    return o;
  }


  /* ---------------------------------------------------------------------------
     Cover mosaic

     The cover is made out of the album itself: a close cutout of every
     photograph, tiled and dimmed, with the names in gold over the top. Each
     tile is zoomed well past its frame so it reads as a fragment — a hand, a
     hem, a face — rather than a shrunken copy of the picture.
     ------------------------------------------------------------------------- */

  var MOSAIC_COLS = 6;

  function buildMosaic(reversed) {
    var tiles = h("div", "cover__mosaic");
    tiles.style.gridTemplateColumns = "repeat(" + MOSAIC_COLS + ", 1fr)";
    tiles.style.gridTemplateRows =
      "repeat(" + Math.ceil(album.length / MOSAIC_COLS) + ", 1fr)";

    var order = reversed ? album.slice().reverse() : album;

    order.forEach(function (photo) {
      var cut = h("div", "cover__cut");
      cut.style.backgroundImage =
        "url(" + photo.src.replace("photos/", "photos/thumbs/") + ")";
      tiles.appendChild(cut);
    });
    return tiles;
  }

  function buildCover() {
    var p = h("div", "page page--cover", { "data-side": "right" });

    p.appendChild(buildMosaic());
    p.appendChild(h("div", "cover__scrim"));

    var inner = h("div", "cover__inner");

    inner.appendChild(h("div", "cover__eyebrow")).textContent = "The Wedding of";

    var names = h("h1", "cover__names");
    names.appendChild(document.createTextNode(COUPLE.one));
    names.appendChild(h("span", "amp")).textContent = "&";
    names.appendChild(document.createTextNode(COUPLE.two));
    inner.appendChild(names);

    inner.appendChild(ornament());
    inner.appendChild(h("div", "cover__meta")).textContent = "Our Album";

    p.appendChild(inner);
    p.appendChild(h("div", "cover__hint")).textContent = "Turn the page";
    return p;
  }

  function buildEnd() {
    var p = h("div", "page page--end", { "data-side": "left" });

    p.appendChild(buildMosaic(true));
    p.appendChild(h("div", "cover__scrim"));

    var inner = h("div", "end__inner");

    inner.appendChild(h("div", "end__eyebrow")).textContent = "With love";
    inner.appendChild(ornament());
    inner.appendChild(h("p", "end__note")).textContent =
      "Thank you for being part of our day. The best of it was having you there.";
    inner.appendChild(ornament());

    var meta = h("div", "end__meta");
    meta.textContent = COUPLE.one + " & " + COUPLE.two;
    inner.appendChild(meta);
    inner.appendChild(restartButton("Read it again"));

    p.appendChild(inner);
    return p;
  }

  /* Offered at the end of the album, where turning forward has run out. The
     click is caught by the book's own handler rather than this element, so it
     works even though copies of it ride along inside the turning page. */
  function restartButton(label) {
    var btn = h("button", "restart", { type: "button", "data-action": "restart" });
    btn.textContent = label;
    return btn;
  }

  /* The outside of the back cover: the same cutouts as the front, and nothing
     on them but the monogram. */
  function buildBack() {
    var p = h("div", "page page--cover page--back", { "data-side": "left" });

    p.appendChild(buildMosaic(true));
    p.appendChild(h("div", "cover__scrim"));

    var inner = h("div", "cover__inner");
    inner.appendChild(ornament());
    var mark = h("div", "back__mark");
    mark.textContent = COUPLE.one.charAt(0) + " & " + COUPLE.two.charAt(0);
    inner.appendChild(mark);
    inner.appendChild(ornament());
    inner.appendChild(restartButton("Back to the beginning"));
    p.appendChild(inner);

    return p;
  }

  function buildPhoto(page, side) {
    var photo = page.photo;
    var span = !!page.half;

    var p = h("div", "page page--photo" + (span ? " page--span" : ""), {
      "data-side": side
    });
    if (span) p.setAttribute("data-half", page.half);

    var frame = h("div", "page__photo" + (span ? " page__photo--span" : ""));

    /* A photograph printed across the gutter already fills both pages. Any
       other one that cannot fill its page on its own gets an enlarged, blurred
       copy of itself behind it, so the page still runs edge to edge and
       nothing is cropped away. applyFit() decides which. */
    if (!span) {
      var backdrop = h("div", "page__backdrop");
      if (photo.lqip) backdrop.style.backgroundImage = "url(" + photo.lqip + ")";
      frame.appendChild(backdrop);
    }

    var img = h("img", null, {
      alt: photo.alt || (COUPLE.one + " and " + COUPLE.two + ", photograph " + page.no),
      width: photo.w,
      height: photo.h,
      decoding: "async"
    });
    img.dataset.src = photo.src;
    img.addEventListener("load", function () { img.classList.add("is-loaded"); });
    frame.appendChild(img);
    p.appendChild(frame);

    if (photo.chapter && page.half !== "right") {
      var plate = h("div", "plate");
      plate.appendChild(h("p", "plate__eyebrow")).textContent = "Chapter";
      plate.appendChild(h("h2", "plate__title")).textContent = photo.chapter;
      if (photo.caption) {
        plate.appendChild(h("p", "plate__caption")).textContent = photo.caption;
      }
      p.appendChild(plate);
    }

    if (page.half !== "left") {
      p.appendChild(h("div", "folio")).textContent =
        String(page.no).padStart(2, "0") + " ⁄ " + TOTAL_PHOTOS;
    }

    return p;
  }

  /* ---------------------------------------------------------------------------
     Leaf construction
     ------------------------------------------------------------------------- */

  function buildLeaves() {
    el.book.textContent = "";      /* this takes the curl scaffold with it */
    curlBox = null;
    leaves = [];

    var perLeaf = stride();
    nLeaves = Math.ceil(pages.length / perLeaf);

    for (var k = 0; k < nLeaves; k++) {
      var leaf = h("div", "leaf");
      leaf.dataset.leaf = k;

      var frontPage, backPage;
      if (perLeaf === 2) {
        frontPage = pages[2 * k];
        backPage  = pages[2 * k + 1];
      } else {
        frontPage = pages[k];
        backPage  = null;              /* verso is blank paper in single-page mode */
      }

      var inner = h("div", "leaf__inner");
      inner.appendChild(face("front", buildPage(frontPage, "right")));
      inner.appendChild(face("back",  buildPage(backPage,  "left")));
      leaf.appendChild(inner);

      el.book.appendChild(leaf);
      leaves.push(leaf);
    }
  }

  function face(which, pageEl) {
    var f = h("div", "face face--" + which);
    f.appendChild(pageEl);
    return f;
  }

  /* ---------------------------------------------------------------------------
     Stacking & flip state
     ------------------------------------------------------------------------- */

  function applyFlips(turningLeaf) {
    for (var i = 0; i < leaves.length; i++) {
      var leaf = leaves[i];
      var flipped = i < state.pos;

      leaf.classList.toggle("is-flipped", flipped);
      /* Turned leaves stack up on the left, untouched ones on the right; the
         most recently turned must sit on top of each pile. */
      leaf.style.zIndex = flipped ? i + 1 : nLeaves - i;

      /* Showing one page at a time, a turned leaf swings out past the left of
         the screen and leaves a sliver behind. Once it has landed, drop it. */
      leaf.style.visibility =
        (state.mode === "single" && flipped && i !== turningLeaf)
          ? "hidden" : "visible";

      /* Only the leaves around the reader are kept in play. Every live leaf
         is two backface-hidden faces inside their own 3D context, and the
         whole lot gets re-composited on each frame of a turn — keeping all
         38 of them costs about seven frames a second. The rest are covered
         by the top of their pile anyway. */
      leaf.hidden = Math.abs(i - state.pos) > 2;
    }
    if (turningLeaf != null && leaves[turningLeaf]) {
      leaves[turningLeaf].style.zIndex = nLeaves + 10;
    }
  }

  function updateShift() {
    if (state.mode !== "spread") {
      el.book.removeAttribute("data-shift");
      return;
    }
    if (state.pos === 0) el.book.dataset.shift = "front";
    else if (state.pos >= nLeaves) el.book.dataset.shift = "back";
    else el.book.removeAttribute("data-shift");
  }


  /* ---------------------------------------------------------------------------
     The turning page

     A rigid plane swinging on a hinge never reads as paper. A real page bows:
     the spine holds one edge, your hand carries the other, and the sheet
     between them bulges toward you before it settles.

     So a leaf in flight is replaced by a copy of itself sliced into vertical
     strips. Each strip is placed on a sine-shaped curve across the page and
     tilted to the local tangent, and shaded by how square-on it faces the
     reader. The bow swells to its fullest halfway through the turn and is
     gone by the time the page lands.
     ------------------------------------------------------------------------- */

  var curlBox = null;

  /* The strips are built once and kept. Creating 20 freshly composited layers
     at the start of every turn is what made the first frames of each one
     stutter; reusing them keeps the layers warm between turns. */
  function curlScaffold(W, H) {
    if (curlBox && curlBox.W === W && curlBox.H === H && curlBox.el.parentNode) {
      return curlBox;
    }
    dropCurl();

    var wrap = h("div", "curl", { "aria-hidden": "true" });
    var sheet = h("div", "curl__sheet");
    var w = W / STRIPS;
    var strips = [];

    for (var i = 0; i < STRIPS; i++) {
      var strip = h("div", "strip");
      /* A hair of overlap: adjacent strips sit at different angles, so butting
         them exactly edge to edge would show daylight between them. */
      strip.style.width = (w + 1.5) + "px";

      var front = h("div", "strip__face strip__face--front");
      var back = h("div", "strip__face strip__face--back");
      var fShade = h("div", "strip__shade");
      var bShade = h("div", "strip__shade");
      front.appendChild(fShade);
      back.appendChild(bShade);
      strip.appendChild(front);
      strip.appendChild(back);
      sheet.appendChild(strip);

      strips.push({
        el: strip,
        u: i / (STRIPS - 1),     /* 0 at the spine, 1 at the free edge */
        faces: [front, back],
        offsets: [-i * w, -(W - (i + 1) * w)],
        shades: [fShade, bShade]
      });
    }

    wrap.appendChild(sheet);
    wrap.style.visibility = "hidden";
    el.book.appendChild(wrap);

    curlBox = { el: wrap, strips: strips, W: W, H: H };
    return curlBox;
  }

  function dropCurl() {
    if (curlBox && curlBox.el.parentNode) {
      curlBox.el.parentNode.removeChild(curlBox.el);
    }
    curlBox = null;
  }

  /* Load this turn's two pages into the strips. */
  function fillCurl(box, frontPage, backPage) {
    var sources = [frontPage, backPage];

    box.strips.forEach(function (st) {
      for (var f = 0; f < 2; f++) {
        var face = st.faces[f];
        var old = face.querySelector(".strip__clone");
        if (old) face.removeChild(old);

        var page = sources[f];
        if (!page) continue;

        var clone = page.cloneNode(true);
        clone.classList.add("strip__clone");
        clone.style.width = box.W + "px";
        clone.style.height = box.H + "px";
        clone.style.left = st.offsets[f] + "px";

        /* A slice is scenery: keep its copies out of the tab order. */
        var buttons = clone.querySelectorAll("button");
        for (var q = 0; q < buttons.length; q++) buttons[q].tabIndex = -1;

        face.insertBefore(clone, face.firstChild);   /* shade stays on top */
      }
    });
  }

  /* Lay the sheet out for a given point in the turn.

     The strips are chained rather than pivoted about a common hinge: each one
     starts where the last one ended and carries its own angle, so the sheet
     keeps its length and can take any shape.

     The shape comes from letting the free edge lead. Each strip runs the same
     turn but the ones nearer the spine start later, so the outer edge lifts
     first, the fold rolls inward, and the paper is flat again by the time it
     lands. A single angle for the whole page — however much you bow it — only
     ever looks like a rotating board.

     m: 0 at the start of the turn, 1 at the end, whichever way it is going. */
  function paintCurl(box, m, forward) {
    var strips = box.strips;
    var w = box.W / STRIPS;
    var x = 0;
    var z = 0;

    for (var i = 0; i < strips.length; i++) {
      var st = strips[i];

      var lagged = clamp((m - LAG * (1 - st.u)) / (1 - LAG), 0, 1);
      var turned = easeInOut(lagged);
      var angle = -Math.PI * (forward ? turned : 1 - turned);

      st.el.style.transform =
        "translate3d(" + x.toFixed(2) + "px,0," + z.toFixed(2) + "px) " +
        "rotateY(" + angle.toFixed(4) + "rad)";

      /* Walk to where this strip ends, and start the next one there. */
      x += w * Math.cos(angle);
      z -= w * Math.sin(angle);

      /* Square-on to the reader is bright; edge-on falls into shadow. Because
         each strip now has its own angle, this shades the curve itself. */
      var facing = Math.abs(Math.cos(angle));
      var dark = (1 - facing) * 0.62 + 0.12 * Math.sin(Math.PI * m);
      st.shades[0].style.opacity = dark;
      st.shades[1].style.opacity = dark;
    }
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function runCurl(leafIndex, forward, done) {
    var leaf = leaves[leafIndex];
    if (!leaf) return done();

    var box = curlScaffold(leaf.offsetWidth, leaf.offsetHeight);
    fillCurl(box,
      leaf.querySelector(".face--front .page"),
      leaf.querySelector(".face--back .page"));

    paintCurl(box, 0, forward);
    box.el.style.visibility = "visible";

    /* Animation frames stop being delivered while a tab is in the background,
       which would otherwise strand the turn — and `state.turning` with it —
       until the reader came back. Whatever happens, the page lands. */
    var landed = false;
    function land() {
      if (landed) return;
      landed = true;
      box.el.style.visibility = "hidden";
      leaf.style.visibility = "";
      done();
    }
    var failsafe = window.setTimeout(land, turnMs * 2 + 500);

    /* At its starting angle the curl is indistinguishable from the leaf it
       stands in for, so let it rasterise for a couple of frames before the
       clock starts. Otherwise the cost of laying down 28 fresh layers lands
       in the first frames of the motion, and the turn opens with a stutter. */
    requestAnimationFrame(function () {
      if (landed) return;
      /* The real leaf steps aside for the duration; what shows underneath is
         exactly what a reader should see as the page lifts away. */
      leaf.style.visibility = "hidden";
      var start = performance.now();

      (function frame(now) {
        var t = clamp((now - start) / turnMs, 0, 1);
        /* Raw progress: the easing is applied per strip, inside paintCurl. */
        paintCurl(box, t, forward);

        if (landed) return;
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          window.clearTimeout(failsafe);
          land();
        }
      })(start);
    });
  }

  /* ---------------------------------------------------------------------------
     Turning
     ------------------------------------------------------------------------- */

  function go(delta) {
    /* A reader flipping quickly shouldn't have taps swallowed by the
       animation, so hold the newest intent and play it out on landing. */
    if (state.turning) {
      state.pending = clamp((state.pending || 0) + delta, -3, 3);
      return;
    }
    setPos(state.pos + delta, true);
  }

  function setPos(next, animate) {
    next = clamp(next, 0, maxPos());
    if (next === state.pos) return;
    if (state.turning) return;

    var forward = next > state.pos;
    var single = Math.abs(next - state.pos) === 1;
    var turningLeaf = forward ? state.pos : next;   /* the leaf actually in flight */

    state.pos = next;

    if (animate && single && !prefersReducedMotion()) {
      state.turning = true;

      applyFlips(turningLeaf);
      updateShift();

      runCurl(turningLeaf, forward, function () {
        state.turning = false;
        applyFlips(null);

        /* Play out whatever was queued while this leaf was in the air, but
           drop it at either cover — otherwise taps that ran past the end come
           back to haunt the next turn. */
        var queued = state.pending || 0;
        state.pending = 0;
        if (queued) {
          var step = queued > 0 ? 1 : -1;
          var target = clamp(state.pos + step, 0, maxPos());
          if (target !== state.pos) {
            state.pending = queued - step;
            setPos(target, true);
          }
        }
      });
    } else {
      /* Jumps from the contents grid land without a flip. */
      state.pending = 0;
      applyFlips(null);
      updateShift();
    }

    afterMove();
  }

  function afterMove() {
    hydrate();
    updateChrome();
    syncHash();
    markContents();
  }

  /* ---------------------------------------------------------------------------
     Image hydration
     ------------------------------------------------------------------------- */

  function hydrate() {
    var centre = primaryPage();
    var lo = centre - HYDRATE_PAD;
    var hi = centre + HYDRATE_PAD;

    for (var i = 0; i < pages.length; i++) {
      if (i < lo || i > hi) continue;
      var page = pages[i];
      if (page.type !== "photo" || page.photo.loaded) continue;
      page.photo.loaded = true;
      loadInto(page.photo);
    }
  }

  function loadInto(photo) {
    /* A photograph can be mounted in more than one page — both halves of a
       spread, or a fresh set of leaves after a mode switch — so address every
       <img> carrying this source. */
    var sel = 'img[data-src="' + photo.src + '"]';
    var imgs = el.book.querySelectorAll(sel);
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].getAttribute("src")) continue;
      imgs[i].src = photo.src;
      var backdrop = imgs[i].parentNode.querySelector(".page__backdrop");
      if (backdrop) backdrop.style.backgroundImage = "url(" + photo.src + ")";
    }
  }

  /* A photograph fills the page when doing so costs little of it; past that it
     is shown whole, over the blurred backdrop. The page has no fixed shape any
     more — it is whatever the window is — so this is decided on every layout. */
  function applyFit() {
    var pw = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue("--pw"));
    var ph = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue("--ph"));
    if (!pw || !ph) return;

    var pageRatio = pw / ph;

    album.forEach(function (photo) {
      var photoRatio = photo.w / photo.h;
      var lost = 1 - Math.min(pageRatio, photoRatio) / Math.max(pageRatio, photoRatio);

      /* Fill the page unless doing so would gut the picture. On a phone an
         upright photograph loses about a third of its width, which is worth it
         for an edge-to-edge page; a landscape one would lose two thirds, which
         is not — that is the only case left that gets bars. */
      var contain = lost > FILL_LIMIT;
      var frames = el.book.querySelectorAll('img[data-src="' + photo.src + '"]');

      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i].parentNode;
        /* A photograph across the gutter fills both pages by construction. */
        if (frame.classList.contains("page__photo--span")) continue;
        frame.classList.toggle("is-contain", contain);
      }
    });
  }

  /* ---------------------------------------------------------------------------
     Chrome (buttons, counter, announcements)
     ------------------------------------------------------------------------- */

  function updateChrome() {
    el.prev.disabled = state.pos <= 0;
    el.next.disabled = state.pos >= maxPos();

    var label;

    var nums = visiblePhotoNos();
    if (nums.length === 2) label = nums[0] + "–" + nums[1];
    else if (nums.length === 1) label = String(nums[0]);

    if (label) {
      el.counter.innerHTML = "<b>" + label + "</b> / " + TOTAL_PHOTOS;
    } else if (state.pos === 0) {
      el.counter.textContent = "Cover";
    } else {
      el.counter.textContent = "The End";
    }

    el.live.textContent = label
      ? "Photograph " + label + " of " + TOTAL_PHOTOS
      : (state.pos === 0 ? "Cover" : "Last page");
  }

  /* ---------------------------------------------------------------------------
     Sizing
     ------------------------------------------------------------------------- */

  function measure() {
    return {
      w: Math.max(el.stage.clientWidth, 200),
      h: Math.max(el.stage.clientHeight, 200)
    };
  }

  function layout() {
    var box = measure();
    var wantSpread = box.w >= SPREAD_MIN_W && box.h >= SPREAD_MIN_H;
    var nextMode = wantSpread ? "spread" : "single";

    if (nextMode !== state.mode) {
      /* Pagination differs between the two layouts — a landscape photograph is
         a whole spread in one and a single page in the other — so the reader's
         place is kept by photograph, not by page number. */
      var keep = visiblePhotoNos()[0];
      var wasAtEnd = state.pos >= maxPos();

      state.mode = nextMode;
      el.app.classList.toggle("mode-single", nextMode === "single");
      pages = buildPageList(nextMode);
      buildLeaves();

      state.pos = keep ? posForPage(pageOfPhoto(keep))
                       : (wasAtEnd ? maxPos() : 0);
      applyFlips(null);
      updateShift();
      /* Rebuilt DOM has fresh <img> elements — re-point the ones already in range. */
      album.forEach(function (photo) { if (photo.loaded) loadInto(photo); });
      hydrate();
      updateChrome();
    }

    /* The book fills the window: a page is half of it across a spread, all of
       it on a single page. Only a very wide window is reined in, where pages
       would otherwise go so squat that photographs lose their tops. */
    var divisor = state.mode === "spread" ? 2 : 1;
    var ph = Math.floor(box.h);
    var pw = Math.floor(Math.min(box.w / divisor, ph * MAX_PAGE_RATIO));

    document.documentElement.style.setProperty("--pw", Math.max(pw, 160) + "px");
    document.documentElement.style.setProperty("--ph", Math.max(ph, 240) + "px");

    applyFit();
  }

  /* ---------------------------------------------------------------------------
     Contents overlay
     ------------------------------------------------------------------------- */

  function buildContents() {
    album.forEach(function (photo, i) {
      var btn = h("button", "thumb", { type: "button" });
      btn.dataset.no = photo.no;

      var img = h("img", null, { alt: "" });
      img.src = photo.src.replace("photos/", "photos/thumbs/");
      img.loading = "lazy";
      img.decoding = "async";
      btn.appendChild(img);

      if (photo.chapter) {
        btn.appendChild(h("span", "thumb__chapter")).textContent = photo.chapter;
      }
      btn.appendChild(h("span", "thumb__no")).textContent =
        String(i + 1).padStart(2, "0");

      btn.setAttribute("aria-label",
        "Go to photograph " + (i + 1) + (photo.chapter ? ", " + photo.chapter : ""));

      btn.addEventListener("click", function () {
        closeContents();
        setPos(posForPage(pageOfPhoto(photo.no)), false);
      });

      el.grid.appendChild(btn);
    });
  }

  function markContents() {
    var here = visiblePhotoNos();
    var thumbs = el.grid.children;
    for (var i = 0; i < thumbs.length; i++) {
      thumbs[i].classList.toggle("is-current",
        here.indexOf(Number(thumbs[i].dataset.no)) !== -1);
    }
  }

  function openContents() {
    el.contents.classList.add("is-open");
    el.contents.removeAttribute("aria-hidden");
    el.openIndex.setAttribute("aria-expanded", "true");
    stopAutoplay();
    markContents();
    var current = el.grid.querySelector(".is-current") || el.grid.firstElementChild;
    if (current) current.focus({ preventScroll: false });
  }

  function closeContents() {
    el.contents.classList.remove("is-open");
    el.contents.setAttribute("aria-hidden", "true");
    el.openIndex.setAttribute("aria-expanded", "false");
    el.openIndex.focus();
  }

  function contentsOpen() { return el.contents.classList.contains("is-open"); }

  /* ---------------------------------------------------------------------------
     Autoplay / fullscreen / music
     ------------------------------------------------------------------------- */

  function startAutoplay() {
    state.autoplay = true;
    el.play.setAttribute("aria-pressed", "true");
    state.timer = window.setInterval(function () {
      if (state.pos >= maxPos()) { stopAutoplay(); return; }
      go(1);
    }, AUTOPLAY_MS);
  }

  function stopAutoplay() {
    state.autoplay = false;
    el.play.setAttribute("aria-pressed", "false");
    if (state.timer) { window.clearInterval(state.timer); state.timer = null; }
  }

  function toggleAutoplay() { state.autoplay ? stopAutoplay() : startAutoplay(); }

  function toggleFullscreen() {
    var doc = document;
    if (!doc.fullscreenElement) {
      (doc.documentElement.requestFullscreen || function () {}).call(doc.documentElement);
    } else {
      (doc.exitFullscreen || function () {}).call(doc);
    }
  }

  /* Drop an mp3 at assets/audio/theme.mp3 and a Music toggle appears on its
     own. With no file there, nothing is added and nothing flickers. */
  function setupMusic() {
    var audio = new Audio("assets/audio/theme.mp3");
    audio.loop = true;
    audio.volume = 0.45;

    audio.addEventListener("canplaythrough", addButton, { once: true });
    audio.addEventListener("loadedmetadata", addButton, { once: true });

    var added = false;
    function addButton() {
      if (added) return;
      added = true;

      var btn = h("button", "tool", { type: "button", "aria-pressed": "false" });
      btn.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M6 12V3l7-1.4v9"/><circle cx="4" cy="12.4" r="2"/>' +
        '<circle cx="11" cy="10.6" r="2"/></svg><span>Music</span>';

      btn.addEventListener("click", function () {
        if (audio.paused) {
          audio.play().then(function () {
            btn.setAttribute("aria-pressed", "true");
          }).catch(function () { /* blocked until the reader interacts */ });
        } else {
          audio.pause();
          btn.setAttribute("aria-pressed", "false");
        }
      });

      el.counter.insertAdjacentElement("afterend", btn);
    }
  }

  /* ---------------------------------------------------------------------------
     Deep links
     ------------------------------------------------------------------------- */

  function syncHash() {
    var here = visiblePhotoNos();
    var hash = here.length ? "#p=" + here[0] : "";
    var url = location.pathname + location.search + hash;
    try { history.replaceState(null, "", url); } catch (e) { /* file:// */ }
  }

  function readHash() {
    var m = /[#&]p=(\d+)/.exec(location.hash);
    if (!m) return;
    var no = clamp(parseInt(m[1], 10), 1, TOTAL_PHOTOS);
    state.pos = posForPage(pageOfPhoto(no));
    applyFlips(null);
    updateShift();
  }


  /* ---------------------------------------------------------------------------
     Chrome that gets out of the way
     ------------------------------------------------------------------------- */

  var idleTimer = null;

  function wake() {
    el.app.classList.remove("chrome-idle");
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(function () {
      if (!contentsOpen()) el.app.classList.add("chrome-idle");
    }, IDLE_MS);
  }

  /* ---------------------------------------------------------------------------
     Input
     ------------------------------------------------------------------------- */

  function wireInput() {
    el.prev.addEventListener("click", function () { stopAutoplay(); go(-1); });
    el.next.addEventListener("click", function () { stopAutoplay(); go(1); });

    el.openIndex.addEventListener("click", openContents);
    el.closeIdx.addEventListener("click", closeContents);
    el.play.addEventListener("click", toggleAutoplay);
    if (el.full) el.full.addEventListener("click", toggleFullscreen);

    el.book.addEventListener("click", function (ev) {
      stopAutoplay();

      if (ev.target.closest('[data-action="restart"]')) {
        setPos(0, false);
        el.live.textContent = "Back at the cover";
        return;
      }

      /* Otherwise the page itself: left half goes back, right half goes on. */
      var rect = el.book.getBoundingClientRect();
      go(ev.clientX - rect.left < rect.width / 2 ? -1 : 1);
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      if (contentsOpen()) {
        if (ev.key === "Escape") { ev.preventDefault(); closeContents(); }
        return;
      }

      switch (ev.key) {
        case "ArrowRight": case "PageDown": case " ":
          ev.preventDefault(); stopAutoplay(); go(1); break;
        case "ArrowLeft": case "PageUp":
          ev.preventDefault(); stopAutoplay(); go(-1); break;
        case "Home":
          ev.preventDefault(); stopAutoplay(); setPos(0, false); break;
        case "End":
          ev.preventDefault(); stopAutoplay(); setPos(maxPos(), false); break;
        case "c": case "C":
          ev.preventDefault(); openContents(); break;
      }
    });

    /* Swipe */
    var start = null;
    el.stage.addEventListener("pointerdown", function (ev) {
      if (ev.pointerType === "mouse") return;
      start = { x: ev.clientX, y: ev.clientY };
    }, { passive: true });

    el.stage.addEventListener("pointerup", function (ev) {
      if (!start) return;
      var dx = ev.clientX - start.x;
      var dy = ev.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        stopAutoplay();
        go(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    ["pointermove", "pointerdown", "keydown", "wheel"].forEach(function (ev) {
      window.addEventListener(ev, wake, { passive: true });
    });

    window.addEventListener("hashchange", function () {
      readHash();
      afterMove();
    });
  }

  /* ---------------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------------- */

  function preloadOpening(done) {
    var first = photos.slice(0, 4);
    if (!first.length) return done();

    var left = first.length;
    var settled = false;

    function tick() {
      el.veilBar.style.transform = "scaleX(" + (1 - left / first.length) + ")";
      if (--left <= 0 && !settled) { settled = true; done(); }
    }

    first.forEach(function (photo) {
      var img = new Image();
      img.onload = img.onerror = tick;
      img.src = photo.src;
    });

    /* Never hold the reader hostage to a slow connection. */
    window.setTimeout(function () {
      if (!settled) { settled = true; done(); }
    }, 4000);
  }

  function init() {
    turnMs = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue("--turn")) || 900;

    pages = buildPageList(state.mode);
    buildLeaves();
    buildContents();
    layout();
    readHash();
    applyFlips(null);
    updateShift();
    hydrate();
    updateChrome();
    markContents();
    wireInput();
    setupMusic();
    wake();

    if (window.ResizeObserver) {
      new ResizeObserver(layout).observe(el.stage);
    } else {
      window.addEventListener("resize", layout);
    }

    preloadOpening(function () {
      el.veil.classList.add("is-done");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
