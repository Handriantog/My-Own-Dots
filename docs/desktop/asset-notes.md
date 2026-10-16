# Plush rig artwork

The desktop uses one neutral plush atlas derived from `public/dots/blue.png`, with separate torso, arms, feet, eyes, mouth, headphones, and pinch tuft. PixiJS texture frames and a deformable torso mesh animate that master. The face and woven cream headphones are protected from color changes. A shallow three-quarter turn moves the same facial features; no independent side-pose images are swapped in.

`public/desktop-dot/rig.json` records each source rectangle, size, pivot, attachment position, and tint policy. The original generated PNG is retained. Authored runtime silhouette masks remove detached generation debris outside the torso/headphones; no bitmap editing script is needed. Fine fur/shading come from the raster asset. The pinching hand is original vector artwork in `src/desktop/renderer/hand.ts`, with its thumb/index contact at local `(0, 0)`.

Both atlas preparation calls used the built-in image generation tool. The reference cat photograph is not included in the application. The source reference and final atlas stay in the repository; intermediate generations remain in the image tool's output directory.

Generation prompt: derive a disassembled, transparent 3×3 character kit from the existing blue plush Dot, preserving furry material, pear-shaped torso, shiny brown eyes, small smile, cream woven headphones, short mitt arms and little feet. The nine parts are neutral white/gray torso; headphones; eye pair; left arm; right arm; smile; left foot; right foot; pinch tuft. Fill hidden anatomy, preserve one identity, use frontal orthographic soft studio lighting, no assembled duplicate character, labels, lines, or background. The actual generated layout is measured explicitly in the rig metadata, rather than assuming a perfect grid.

Final edit prompt (verbatim):

> Use case: precise-object-edit. Clean the alpha edges of this production character-parts atlas. Keep EXACTLY all nine components, their locations, sizes, geometry, colors, fine fur detail, face features, and cream headphones unchanged. Remove ALL floating speckles, white debris, ghost blue pixels, detached tufts and large fringe islands outside the actual connected silhouette of each component. Every surrounding gutter must be perfectly empty transparent pixels. Preserve just a very short fine clean natural fur fringe at the actual silhouette, NOT clumps or fuzzy haze outside it. No added shadows, no colored or white background, no labels or new objects. Preserve real alpha transparency. The torso should be a clean softly furry pear silhouette, each limb a clean fur mitten shape. Mouth and eyes completely clean with empty transparency around them. Headphones completely clean with real transparent hole inside.

Residual alpha debris is why the runtime silhouette masks remain necessary. The hand and custom cursor do not derive from stock artwork. Sound authoring provenance remains in the existing audition catalog; these effects are still provisional.
