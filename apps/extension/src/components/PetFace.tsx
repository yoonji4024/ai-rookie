import {forwardRef,useImperativeHandle,useRef} from 'react';
import type {FaceMood,FacsLookup} from '../shared/face/faceRig';
import neutral from '../assets/duri/neutral.png';
import happy from '../assets/duri/happy.png';
import sad from '../assets/duri/sad.png';
import worried from '../assets/duri/worried.png';

export interface PetFaceHandle {
  apply(lookup:FacsLookup,earUp?:number):void;
  setMood(mood:FaceMood,earUp?:number):void;
}
export interface PetFaceProps {petName:string;size?:number;mood?:FaceMood}
const portraits:Record<FaceMood,string>={neutral,happy,sad,curious:worried,listening:neutral};

/** Original user artwork. Expressions describe the companion, never answer
 * correctness or the user's cognitive condition. */
const PetFace=forwardRef<PetFaceHandle,PetFaceProps>(function PetFace({petName,size=132,mood='neutral'},ref){
  const image=useRef<HTMLImageElement>(null);
  const paint=(next:FaceMood)=>{
    if(image.current&&image.current.getAttribute('src')!==portraits[next])image.current.src=portraits[next];
  };
  useImperativeHandle(ref,()=>({
    setMood:paint,
    // Preserve the old controller interface; still images do not provide lip sync.
    apply:lookup=>paint((lookup('mouthSmileLeft')+lookup('mouthSmileRight'))/2>.4?'happy':'neutral'),
  }));
  return <img ref={image} src={portraits[mood]} alt={`${petName}, 파란 해마`} width={size} height={size}
    draggable={false} className="duri-portrait"
    style={{display:'block',objectFit:'contain',maxWidth:'100%'}}/>;
});
export default PetFace;
