import express from 'express';
import { etsyRequest, getShopId } from './etsy.js';
const router=express.Router();
function listingId(v){const id=String(v||'').trim();if(!/^\d+$/.test(id)) {const e=new Error('Invalid listingId');e.status=400;throw e;}return id;}
function rankOf(x){return Number(x?.rank ?? x?.listing_image_rank ?? 9999);}
router.get('/listings/:listingId/source',async(req,res,next)=>{try{
 const id=listingId(req.params.listingId);
 const [listing,images]=await Promise.all([etsyRequest('/listings/'+id),etsyRequest('/listings/'+id+'/images')]);
 const rows=Array.isArray(images?.results)?images.results:[];
 rows.sort((a,b)=>rankOf(a)-rankOf(b));
 const source=rows[0];
 if(!source) return res.status(409).json({error:'rank_1_artwork_unavailable',generation_allowed:false,etsy_modified:false});
 const url=source.url_fullxfull||source.url_300x300||source.url_570xN||null;
 if(!url) return res.status(409).json({error:'rank_1_artwork_url_unavailable',generation_allowed:false,etsy_modified:false});
 res.json({ok:true,listing_id:id,title:listing?.title||'',source_locked:true,source_rule:'ETSY_LISTING_RANK_1',source_artwork:{listing_image_id:source.listing_image_id,rank:rankOf(source),url,width:source.full_width||null,height:source.full_height||null},generation_allowed:true,etsy_modified:false});
 }catch(e){next(e);}});
router.post('/jobs/prepare',async(req,res,next)=>{try{
 const id=listingId(req.body?.listingId); const preset=String(req.body?.preset||'floor_large');
 const images=await etsyRequest('/listings/'+id+'/images'); const rows=Array.isArray(images?.results)?images.results:[]; rows.sort((a,b)=>rankOf(a)-rankOf(b)); const source=rows[0];
 const url=source&&(source.url_fullxfull||source.url_300x300||source.url_570xN);
 if(!source||!url) return res.status(409).json({error:'rank_1_artwork_unavailable',generation_allowed:false,etsy_modified:false});
 res.json({ok:true,preview_only:true,listing_id:id,preset,source_locked:true,source_rule:'ETSY_LISTING_RANK_1',source_artwork:{listing_image_id:source.listing_image_id,rank:rankOf(source),url},generation_contract:{preserve_artwork_exactly:true,allow_redraw:false,allow_recolor:false,allow_crop:false,allow_stretch:false,primary_presets:['floor_large','wall_large'],minimum_short_side_px:2000},provider_connected:false,generation_allowed:false,next_required:'generation_provider',etsy_modified:false});
 }catch(e){next(e);}});
export default router;