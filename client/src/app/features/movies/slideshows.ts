import { Component } from '@angular/core';
import { MovieStudio, STUDIO } from './studio';

@Component({
  selector: 'app-slideshows',
  imports: [MovieStudio],
  providers: [{ provide: STUDIO, useValue: { collection: 'slideshows', title: 'Slideshows' } }],
  template: '<app-movie-studio />',
  styles: ':host { display: block; height: 100%; }',
})
export class Slideshows {}
