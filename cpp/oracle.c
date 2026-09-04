/*
 * Native oracle harness (M4, design §6 test pyramid).
 *
 * Runs the SAME op chains as the TS side against a native leptonica build
 * (same versions.json pins), producing golden PNG bytes and scalar JSON.
 * The wasm tests byte-compare against these outputs — the correctness anchor
 * is a different toolchain, not this library's own output.
 *
 * usage: oracle <chain.json> <rgba.bin> <out.png> <out.json>
 *
 * chain.json: {"width":W,"height":H,"rgba":"<path, unused — argv[2] wins>",
 *             "ops":[{...},...],"queries":[{...},...]}
 * Ops mirror src/protocol.ts (applyOp). Unknown ops/fields exit(2) loudly.
 * Output PNG is written to argv[3]; scalar results (skew/count) to argv[4].
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "allheaders.h"

/* ------------------------------------------------------------------ */
/* Minimal JSON reader — flat objects, numeric/string values, arrays. */
/* ------------------------------------------------------------------ */

typedef struct {
    const char *buf;
    size_t pos, len;
} Json;

static void jskipws(Json *j) {
    while (j->pos < j->len) {
        char c = j->buf[j->pos];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') j->pos++;
        else break;
    }
}

static int jpeek(Json *j) { jskipws(j); return j->pos < j->len ? j->buf[j->pos] : -1; }

static void jexpect(Json *j, char c) {
    if (jpeek(j) != c) { fprintf(stderr, "oracle: expected '%c' at %zu\n", c, j->pos); exit(2); }
    j->pos++;
}

static double jnum(Json *j) {
    jskipws(j);
    char *end;
    double v = strtod(j->buf + j->pos, &end);
    if (end == j->buf + j->pos) { fprintf(stderr, "oracle: bad number at %zu\n", j->pos); exit(2); }
    j->pos = (size_t)(end - j->buf);
    return v;
}

static void jstr(Json *j, char *out, size_t cap) {
    jexpect(j, '"');
    size_t n = 0;
    while (j->pos < j->len && j->buf[j->pos] != '"') {
        char c = j->buf[j->pos++];
        if (c == '\\' && j->pos < j->len) c = j->buf[j->pos++];
        if (n + 1 < cap) out[n++] = c;
    }
    out[n] = 0;
    jexpect(j, '"');
}

static void jskipval(Json *j) {
    int c = jpeek(j);
    if (c == '"') { char tmp[64]; jstr(j, tmp, sizeof tmp); return; }
    if (c == '{' || c == '[') {
        char open = (char)c, close = (c == '{') ? '}' : ']';
        j->pos++;
        int depth = 1;
        while (j->pos < j->len && depth > 0) {
            char ch = j->buf[j->pos];
            if (ch == '"') { char tmp[64]; jstr(j, tmp, sizeof tmp); continue; }
            if (ch == open) depth++;
            else if (ch == close) depth--;
            j->pos++;
        }
        return;
    }
    while (j->pos < j->len) {
        char ch = j->buf[j->pos];
        if (ch == ',' || ch == '}' || ch == ']') break;
        j->pos++;
    }
}

/* ------------------------------------------------------------------ */
/* Chain state.                                                         */
/* ------------------------------------------------------------------ */

typedef struct {
    PIX *pix;
    double skewAngle, skewConf;
    long pixelCount;
} Chain;

static void applyOp(Chain *ch, Json *j);
static void applyQuery(Chain *ch, Json *j);

/* ------------------------------------------------------------------ */
/* Op implementations — mirror bindings.cpp 1:1.                        */
/* ------------------------------------------------------------------ */

static PIX *opFromRGBA(const char *rgbaPath, int w, int h) {
    if (w <= 0 || h <= 0 || w > 0x00ffffff / h) return NULL;
    FILE *f = fopen(rgbaPath, "rb");
    if (!f) { fprintf(stderr, "oracle: cannot open %s\n", rgbaPath); return NULL; }
    PIX *pix = pixCreateNoInit(w, h, 32);
    if (!pix) { fclose(f); return NULL; }
    pixSetSpp(pix, 4);
    size_t need = (size_t)w * h * 4;
    size_t words = (size_t)pixGetWpl(pix) * h;
    l_uint32 *data = pixGetData(pix);
    if (fread(data, 1, words * 4, f) != words * 4 || words * 4 != need) {
        /* wpl is w when 32bpp and no padding surprises (same check as
         * bindings.cpp fromRGBA); a mismatch means corrupt input. */
        pixDestroy(&pix);
        fclose(f);
        return NULL;
    }
    fclose(f);
    if (pixEndianByteSwap(pix) != 0) { pixDestroy(&pix); return NULL; }
    return pix;
}

static PIX *opToGray(PIX *src) { return pixConvertTo8(src, 0); }

static PIX *opThreshold(PIX *src, int level) { return pixThresholdToBinary(src, level); }

static PIX *opOtsu(PIX *src, int tile, float factor) {
    PIX *pixth = NULL, *pixd = NULL;
    if (pixOtsuAdaptiveThreshold(src, tile, tile, 0, 0, factor, &pixth, &pixd) != 0) {
        pixDestroy(&pixth);
        return NULL;
    }
    pixDestroy(&pixth);
    return pixd;
}

static PIX *opSauvola(PIX *src, int whsize, float factor) {
    PIX *pixd = NULL;
    /* addborder=1: the input never has leptonica's sauvola border, so the
     * output keeps the source dimensions (pixSauvolaBinarizeTiled does the
     * same internally — binarize.c pixSauvolaBinarizeTiled wrapper). */
    if (pixSauvolaBinarize(src, whsize, factor, 1, NULL, NULL, NULL, &pixd) != 0) return NULL;
    return pixd;
}

static PIX *opDeskew(PIX *src, int reduction) { return pixDeskew(src, reduction); }

static PIX *opRotate(PIX *src, float angle, int qualityShear) {
    /* pixRotate (not pixRotateAM): it handles every depth — 1bpp falls
     * back to shear/sampling internally, so the protocol's depth rule
     * "rotate: any depth" actually holds (F7). quality maps to the
     * rotation type; leptonica may still adjust it for 1bpp. */
    return pixRotate(src, angle, qualityShear ? L_ROTATE_SHEAR : L_ROTATE_AREA_MAP,
                     L_BRING_IN_WHITE, 0, 0);
}

static PIX *opScale(PIX *src, float fx, float fy) {
    return pixScale(src, fx, fy);
}

static PIX *opShear(PIX *src, int horizontal, float angle) {
    /* Center shears: pixHShearCenter/pixVShearCenter pass the mid-line
     * (yloc = h/2 for H, xloc = w/2 for V) so the sheared image stays
     * centered — the manual mid-line computation above had h/w swapped. */
    if (horizontal)
        return pixHShearCenter(NULL, src, angle, L_BRING_IN_WHITE);
    return pixVShearCenter(NULL, src, angle, L_BRING_IN_WHITE);
}

static PIX *opClip(PIX *src, int x, int y, int w, int h) {
    BOX *box = boxCreate(x, y, w, h);
    PIX *out = pixClipRectangle(src, box, NULL);
    boxDestroy(&box);
    return out;
}

static PIX *opTranslate(PIX *src, int dx, int dy) {
    /* L_SET_PIXELS == L_BRING_IN_WHITE numerically, but the incolor
     * parameter means the constant fill value — use the intended constant. */
    return pixTranslate(NULL, src, dx, dy, L_BRING_IN_WHITE);
}

static PIX *opMorph(PIX *src, const char *kind, int w, int h) {
    /* Dwa signatures: (pixd, pixs, hsize, vsize) — pixd first. hsize is the
     * horizontal sel extent, which is protocol w (w x h brick). */
    if (!strcmp(kind, "dilate")) return pixDilateBrickDwa(NULL, src, w, h);
    if (!strcmp(kind, "erode"))  return pixErodeBrickDwa(NULL, src, w, h);
    if (!strcmp(kind, "open"))   return pixOpenBrickDwa(NULL, src, w, h);
    if (!strcmp(kind, "close"))  return pixCloseBrickDwa(NULL, src, w, h);
    return NULL;
}

static PIX *opBitwise(PIX *src, PIX *other, const char *kind) {
    PIX *out = pixCopy(NULL, src);
    if (!out) return NULL;
    if (!strcmp(kind, "or")) { pixOr(out, src, other); return out; }
    if (!strcmp(kind, "and")) { pixAnd(out, src, other); return out; }
    if (!strcmp(kind, "xor")) { pixXor(out, src, other); return out; }
    pixDestroy(&out);
    return NULL;
}

static PIX *opBlend(PIX *src, PIX *other, float frac) {
    /* pixBlend(pixs1, pixs2, x, y, fract) — 5 params, no dest: the
     * first build passed a spurious NULL dest (CI run 33917519336,
     * native-oracle job compile error). */
    return pixBlend(src, other, 0, 0, frac);
}

static PIX *opAddBorder(PIX *src, int t, int val) {
    return pixAddBorder(src, t, val);
}

static PIX *opSobel(PIX *src, int orient) {
    return pixSobelEdgeFilter(src, orient);
}

/* applyOp (F4, mid-build check): dispatches on the "op" tag, then reads
 * each remaining field BY NAME with the op's own defaults — never by
 * position. The protocol has string fields (shear.direction,
 * sobel.orientation, rotate.quality) and an array (toGray.weights) that
 * positional numeric parsing cannot represent. */
static void applyOp(Chain *ch, Json *j) {
    char kind[16] = {0};
    /* Named numeric slots — one per protocol key that carries a number.
     * Reading by key name (not position) is what makes field order in
     * chain.json irrelevant. */
    double vLevel = 0, vTile = 0, vFactor = 0, vWhsize = 0, vReduction = 0;
    double vAngle = 0, vFx = 0, vFy = 0, vX = 0, vY = 0, vW = 0, vH = 0;
    double vDx = 0, vDy = 0, vFrac = 0, vT = 0, vVal = 0;
    int hasFy = 0, hasTile = 0, hasFactor = 0, hasReduction = 0;
    char sDirection[16] = "h", sOrientation[16] = "all", sQuality[16] = "area";
    double weights[3] = {0, 0, 0};
    int hasWeights = 0;
    /* Track which optional fields were explicitly given so defaults can
     * distinguish "0 given" from "omitted" (F11: tile=0 is invalid in
     * leptonica anyway, but factor=0.0 is a legitimate explicit choice). */

    while (jpeek(j) != '}') {
        char key[32];
        jstr(j, key, sizeof key);
        jexpect(j, ':');
        if (!strcmp(key, "op")) {
            jstr(j, kind, sizeof kind);
        } else if (!strcmp(key, "direction")) {
            jstr(j, sDirection, sizeof sDirection);
        } else if (!strcmp(key, "orientation")) {
            jstr(j, sOrientation, sizeof sOrientation);
        } else if (!strcmp(key, "quality")) {
            jstr(j, sQuality, sizeof sQuality);
        } else if (!strcmp(key, "weights")) {
            /* toGray custom weights: [r, g, b] */
            jexpect(j, '[');
            for (int i = 0; i < 3; i++) {
                weights[i] = jnum(j);
                if (i < 2) jexpect(j, ',');
            }
            jexpect(j, ']');
            hasWeights = 1;
        } else if (!strcmp(key, "other")) {
            /* Binary-op operand (F5): the golden strategy is a same-image
             * idempotence check — the harness runs both operands on the
             * chain's current image, so the handle id is read but unused. */
            (void)jnum(j);
        } else if (!strcmp(key, "level")) {
            vLevel = jnum(j);
        } else if (!strcmp(key, "tile")) {
            vTile = jnum(j); hasTile = 1;
        } else if (!strcmp(key, "factor")) {
            vFactor = jnum(j); hasFactor = 1;
        } else if (!strcmp(key, "whsize")) {
            vWhsize = jnum(j);
        } else if (!strcmp(key, "reduction")) {
            vReduction = jnum(j); hasReduction = 1;
        } else if (!strcmp(key, "angle")) {
            vAngle = jnum(j);
        } else if (!strcmp(key, "fx")) {
            vFx = jnum(j);
        } else if (!strcmp(key, "fy")) {
            vFy = jnum(j); hasFy = 1;
        } else if (!strcmp(key, "x")) {
            vX = jnum(j);
        } else if (!strcmp(key, "y")) {
            vY = jnum(j);
        } else if (!strcmp(key, "w")) {
            vW = jnum(j);
        } else if (!strcmp(key, "h")) {
            vH = jnum(j);
        } else if (!strcmp(key, "dx")) {
            vDx = jnum(j);
        } else if (!strcmp(key, "dy")) {
            vDy = jnum(j);
        } else if (!strcmp(key, "frac")) {
            vFrac = jnum(j);
        } else if (!strcmp(key, "t")) {
            vT = jnum(j);
        } else if (!strcmp(key, "val")) {
            vVal = jnum(j);
        } else {
            fprintf(stderr, "oracle: unknown field '%s' in op '%s'\n", key, kind);
            exit(2);
        }
        if (jpeek(j) == ',') j->pos++;
    }
    jexpect(j, '}');

    /* Defaults (protocol.ts): every optional field has a defined value
     * here, so a chain.json that omits them behaves identically to one
     * that spells them out (F11). */
    if (!strcmp(kind, "toGray")) {
        PIX *out = hasWeights ? pixConvertRGBToGray(ch->pix, (float)weights[0], (float)weights[1], (float)weights[2]) : opToGray(ch->pix);
        if (!out) { fprintf(stderr, "oracle: op 'toGray' returned NULL\n"); exit(3); }
        pixDestroy(&ch->pix);
        ch->pix = out;
        return;
    }
    PIX *out = NULL;
    if (!strcmp(kind, "threshold")) out = opThreshold(ch->pix, (int)vLevel);
    else if (!strcmp(kind, "otsu")) out = opOtsu(ch->pix, (int)(hasTile ? vTile : 16), (float)(hasFactor ? vFactor : 0.1));
    else if (!strcmp(kind, "sauvola")) out = opSauvola(ch->pix, (int)vWhsize, (float)(hasFactor ? vFactor : 0.34));
    else if (!strcmp(kind, "deskew")) out = opDeskew(ch->pix, (int)(hasReduction ? vReduction : 2));
    else if (!strcmp(kind, "rotate")) {
        if (strcmp(sQuality, "area") && strcmp(sQuality, "shear")) { fprintf(stderr, "oracle: bad rotate quality '%s'\n", sQuality); exit(2); }
        out = opRotate(ch->pix, (float)vAngle, !strcmp(sQuality, "shear"));
    }
    else if (!strcmp(kind, "scale")) out = opScale(ch->pix, (float)vFx, (float)(hasFy ? vFy : vFx));
    else if (!strcmp(kind, "shear")) {
        if (strcmp(sDirection, "h") && strcmp(sDirection, "v")) { fprintf(stderr, "oracle: bad shear direction '%s'\n", sDirection); exit(2); }
        out = opShear(ch->pix, !strcmp(sDirection, "h"), (float)vAngle);
    }
    else if (!strcmp(kind, "clip")) out = opClip(ch->pix, (int)vX, (int)vY, (int)vW, (int)vH);
    else if (!strcmp(kind, "translate")) out = opTranslate(ch->pix, (int)vDx, (int)vDy);
    else if (!strcmp(kind, "dilate") || !strcmp(kind, "erode") || !strcmp(kind, "open") || !strcmp(kind, "close"))
        out = opMorph(ch->pix, kind, (int)vW, (int)vH);
    else if (!strcmp(kind, "or") || !strcmp(kind, "and") || !strcmp(kind, "xor"))
        out = opBitwise(ch->pix, ch->pix, kind);
    else if (!strcmp(kind, "blend")) out = opBlend(ch->pix, ch->pix, (float)vFrac);
    else if (!strcmp(kind, "addBorder")) out = opAddBorder(ch->pix, (int)vT, (int)vVal);
    else if (!strcmp(kind, "sobel")) {
        int orient = L_ALL_EDGES;
        if (!strcmp(sOrientation, "h")) orient = L_HORIZONTAL_EDGES;
        else if (!strcmp(sOrientation, "v")) orient = L_VERTICAL_EDGES;
        else if (strcmp(sOrientation, "all")) { fprintf(stderr, "oracle: bad sobel orientation '%s'\n", sOrientation); exit(2); }
        out = opSobel(ch->pix, orient);
    }
    else { fprintf(stderr, "oracle: unknown op '%s'\n", kind); exit(2); }

    if (!out) { fprintf(stderr, "oracle: op '%s' returned NULL\n", kind); exit(3); }
    pixDestroy(&ch->pix);
    ch->pix = out;
}

static void applyQuery(Chain *ch, Json *j) {
    char kind[16] = {0};
    while (jpeek(j) != '}') {
        char key[32];
        jstr(j, key, sizeof key);
        jexpect(j, ':');
        if (!strcmp(key, "query")) jstr(j, kind, sizeof kind);
        else jskipval(j);
        if (jpeek(j) == ',') j->pos++;
    }
    jexpect(j, '}');

    if (!strcmp(kind, "findSkew")) {
        l_float32 angle = 0, conf = 0;
        if (pixFindSkew(ch->pix, &angle, &conf) == 0) {
            ch->skewAngle = angle;
            ch->skewConf = conf;
        }
    } else if (!strcmp(kind, "countPixels")) {
        l_int32 count = 0;
        if (pixCountPixels(ch->pix, &count, 0) == 0) ch->pixelCount = count;
    } else {
        fprintf(stderr, "oracle: unknown query '%s'\n", kind); exit(2);
    }
}

int main(int argc, char **argv) {
    if (argc != 5) {
        fprintf(stderr, "usage: oracle <chain.json> <rgba.bin> <out.png> <out.json>\n");
        return 1;
    }

    FILE *f = fopen(argv[1], "rb");
    if (!f) { fprintf(stderr, "oracle: cannot open %s\n", argv[1]); return 2; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { fclose(f); return 2; }
    buf[n] = 0;
    fclose(f);

    Json j = { buf, 0, (size_t)n };
    int width = 0, height = 0;
    size_t opsStart = 0, opsEnd = 0, queriesStart = 0, queriesEnd = 0;

    jexpect(&j, '{');
    while (jpeek(&j) != '}') {
        char key[32];
        jstr(&j, key, sizeof key);
        jexpect(&j, ':');
        if (!strcmp(key, "width")) width = (int)jnum(&j);
        else if (!strcmp(key, "height")) height = (int)jnum(&j);
        else if (!strcmp(key, "ops") || !strcmp(key, "queries")) {
            size_t start = j.pos;
            jskipval(&j);
            if (!strcmp(key, "ops")) { opsStart = start; opsEnd = j.pos; }
            else { queriesStart = start; queriesEnd = j.pos; }
        }
        else jskipval(&j);
        if (jpeek(&j) == ',') j.pos++;
    }

    if (width <= 0 || height <= 0) { fprintf(stderr, "oracle: bad dimensions\n"); return 2; }

    Chain ch = { opFromRGBA(argv[2], width, height), 0, 0, 0 };
    if (!ch.pix) { fprintf(stderr, "oracle: fromRGBA failed\n"); return 3; }

    if (opsStart) {
        Json oj = { j.buf, opsStart, opsEnd };
        jexpect(&oj, '[');
        while (jpeek(&oj) != ']') {
            jexpect(&oj, '{');
            applyOp(&ch, &oj);
            if (jpeek(&oj) == ',') oj.pos++;
        }
    }
    if (queriesStart) {
        Json qj = { j.buf, queriesStart, queriesEnd };
        jexpect(&qj, '[');
        while (jpeek(&qj) != ']') {
            jexpect(&qj, '{');
            applyQuery(&ch, &qj);
            if (jpeek(&qj) == ',') qj.pos++;
        }
    }

    if (pixWrite(argv[3], ch.pix, IFF_PNG) != 0) { fprintf(stderr, "oracle: png write failed\n"); return 4; }

    FILE *out = fopen(argv[4], "wb");
    if (!out) return 4;
    fprintf(out, "{\"skewAngle\":%.6f,\"skewConf\":%.6f,\"pixelCount\":%ld}\n",
            ch.skewAngle, ch.skewConf, ch.pixelCount);
    fclose(out);

    pixDestroy(&ch.pix);
    free(buf);
    return 0;
}
